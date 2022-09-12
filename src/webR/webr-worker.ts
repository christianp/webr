import { loadScript } from './compat';
import { ChannelWorker } from './chan/channel';
import { Message, Request, newResponse } from './chan/message';
import { FSNode, WebROptions, EvalRCodeOptions } from './webr-main';
import { Module } from './module';
import { IN_NODE } from './compat';
import {
  isRObjImpl,
  RObjImpl,
  RPtr,
  RTargetObj,
  RTargetPtr,
  RTargetType,
  RType,
  RawType,
  RTargetRaw,
} from './robj';

let initialised = false;

const onWorkerMessage = function (msg: Message) {
  if (!msg || !msg.type || msg.type !== 'init') {
    return;
  }
  if (initialised) {
    throw new Error("Can't initialise worker multiple times.");
  }
  init(msg.data as Required<WebROptions>);
  initialised = true;
};

if (IN_NODE) {
  require('worker_threads').parentPort.on('message', onWorkerMessage);
  (globalThis as any).XMLHttpRequest = require('xmlhttprequest').XMLHttpRequest as XMLHttpRequest;
} else {
  globalThis.onmessage = (ev: MessageEvent) => onWorkerMessage(ev.data as Message);
}

type XHRResponse = {
  status: number;
  response: string | ArrayBuffer;
};

const Module = {} as Module;
let _config: Required<WebROptions>;

function inputOrDispatch(chan: ChannelWorker): string {
  for (;;) {
    // This blocks the thread until a response
    const msg: Message = chan.read();

    switch (msg.type) {
      case 'stdin':
        return msg.data as string;

      case 'request': {
        const req = msg as Request;
        const reqMsg = req.data.msg;

        const write = (resp: any, transferables?: [Transferable]) =>
          chan.write(newResponse(req.data.uuid, resp, transferables));
        switch (reqMsg.type) {
          case 'putFileData': {
            // FIXME: Use a replacer + reviver to transfer Uint8Array
            const data = Uint8Array.from(Object.values(reqMsg.data.data as ArrayLike<number>));
            write(putFileData(reqMsg.data.name as string, data));
            continue;
          }
          case 'getFileData': {
            const out = getFileData(reqMsg.data.name as string);
            write(out, [out.buffer]);
            continue;
          }
          case 'getFSNode':
            write(getFSNode(reqMsg.data.path as string));
            continue;
          case 'evalRCode': {
            const data = reqMsg.data as {
              code: string;
              env: RPtr;
              options: EvalRCodeOptions;
            };
            try {
              write(evalRCode(data.code, data.env, data.options));
            } catch (_e) {
              const e = _e as Error;
              write({
                type: RTargetType.ERR,
                obj: { name: e.name, message: e.message, stack: e.stack },
              });
            }
            continue;
          }
          case 'newRObject': {
            const data = reqMsg.data as {
              obj: RTargetRaw;
            };
            try {
              const res = new RObjImpl(data.obj);
              write({ obj: res.ptr, methods: RObjImpl.getMethods(res), type: RTargetType.PTR });
            } catch (_e) {
              const e = _e as Error;
              write({
                type: RTargetType.ERR,
                obj: { name: e.name, message: e.message, stack: e.stack },
              });
            }
            continue;
          }
          case 'callRObjMethod': {
            const data = reqMsg.data as {
              target: RTargetPtr;
              prop: string;
              args: RTargetObj[];
            };
            try {
              write(callRObjMethod(RObjImpl.wrap(data.target.obj), data.prop, data.args));
            } catch (_e) {
              const e = _e as Error;
              write({
                type: RTargetType.ERR,
                obj: { name: e.name, message: e.message, stack: e.stack },
              });
            }
            continue;
          }
          case 'installPackage':
            write(
              evalRCode(
                `webr::install("${reqMsg.data.name as string}", repos="${_config.PKG_URL}")`
              )
            );
            continue;
          default:
            throw new Error('Unknown event `' + reqMsg.type + '`');
        }
      }

      default:
        throw new Error('Unknown event `' + msg.type + '`');
    }
  }
}

function getFSNode(path: string): FSNode {
  const node = FS.lookupPath(path, {}).node;
  return copyFSNode(node as FSNode);
}

function copyFSNode(obj: FSNode): FSNode {
  const retObj = {
    id: obj.id,
    name: obj.name,
    mode: obj.mode,
    isFolder: obj.isFolder,
    contents: {},
  };
  if (obj.isFolder) {
    retObj.contents = Object.entries(obj.contents).map(([, node]) => copyFSNode(node));
  }
  return retObj;
}

function downloadFileContent(URL: string, headers: Array<string> = []): XHRResponse {
  const request = new XMLHttpRequest();
  request.open('GET', URL, false);
  request.responseType = 'arraybuffer';

  try {
    headers.forEach((header) => {
      const splitHeader = header.split(': ');
      request.setRequestHeader(splitHeader[0], splitHeader[1]);
    });
  } catch {
    const responseText = 'An error occured setting headers in XMLHttpRequest';
    console.error(responseText);
    return { status: 400, response: responseText };
  }

  try {
    request.send(null);
    if (request.status >= 200 && request.status < 300) {
      return { status: request.status, response: request.response as ArrayBuffer };
    } else {
      const responseText = new TextDecoder().decode(request.response as ArrayBuffer);
      console.error(`Error fetching ${URL} - ${responseText}`);
      return { status: request.status, response: responseText };
    }
  } catch {
    return { status: 400, response: 'An error occured in XMLHttpRequest' };
  }
}

/**
 * For a given RObjImpl object, call the given method with arguments
 *
 * Returns a RTargetObj containing either a reference to the resulting SEXP
 * object in WASM memory, or the object represented in an equivalent raw
 * JS form.
 *
 * @param {RObjImpl}  obj The R RObj object
 * @param {string} [prop] RObj method to invoke
 * @param {RTargetObj[]} [args] List of arguments to call with
 * @return {RTargetObj} The resulting R object
 */
function callRObjMethod(obj: RObjImpl, prop: string, args: RTargetObj[]): RTargetObj {
  if (!(prop in obj)) {
    throw new ReferenceError(`${prop} is not defined`);
  }

  const fn = obj[prop as keyof typeof obj];
  if (typeof fn !== 'function') {
    throw Error('Requested property cannot be invoked');
  }

  const res = (fn as Function).apply(
    obj,
    Array.from({ length: args.length }, (_, idx) => {
      const arg = args[idx];
      return arg.type === RTargetType.PTR ? RObjImpl.wrap(arg.obj) : arg.obj;
    })
  ) as RawType | RObjImpl;

  if (isRObjImpl(res)) {
    return { obj: res.ptr, methods: RObjImpl.getMethods(res), type: RTargetType.PTR };
  } else {
    return { obj: res, type: RTargetType.RAW };
  }
}

/**
 * Evaluate the given R code
 *
 * Returns a RTargetObj containing a reference to the resulting SEXP object
 * in WASM memory.
 *
 * @param {string}  code The R code to evaluate.
 * @param {RPtr} [env] An RPtr to the environment to evaluate within.
 * @param {Object<string,any>} [options={}] Options for the execution environment.
 * @param {boolean} [options.withHandlers] Should the code be executed using a
 * tryCatch with handlers in place, capturing conditions such as errors?
 * @return {RTargetObj} The resulting R object.
 */
function evalRCode(code: string, env?: RPtr, options: EvalRCodeOptions = {}): RTargetObj {
  const _options: Required<EvalRCodeOptions> = Object.assign({ withHandlers: true }, options);

  let envObj = RObjImpl.globalEnv;
  if (env) {
    envObj = RObjImpl.wrap(env);
    if (envObj.type !== RType.Environment) {
      throw new Error('Attempted to eval R code with an env argument with invalid SEXP type');
    }
  }

  const str = Module.allocateUTF8(`withAutoprint({${code}}, echo = FALSE)$value`);
  const evalResult = RObjImpl.wrap(Module._evalRCode(str, envObj.ptr, _options.withHandlers));
  Module._free(str);

  const error = evalResult.get(3);
  if (!error.isNull()) {
    throw new Error(error.get(1).toJs()?.toString());
  }

  return { obj: evalResult.ptr, methods: RObjImpl.getMethods(evalResult), type: RTargetType.PTR };
}

function getFileData(name: string): Uint8Array {
  const size = FS.stat(name).size as number;
  const stream = FS.open(name, 'r');
  const buf = new Uint8Array(size);
  FS.read(stream, buf, 0, size, 0);
  FS.close(stream);
  return buf;
}

function putFileData(name: string, data: Uint8Array) {
  Module.FS.createDataFile('/', name, data, true, true, true);
}

function init(config: Required<WebROptions>) {
  _config = config;

  Module.preRun = [];
  Module.arguments = _config.RArgs;
  Module.noExitRuntime = true;
  Module.noImageDecoding = true;
  Module.noAudioDecoding = true;

  Module.preRun.push(() => {
    if (IN_NODE) {
      globalThis.FS = Module.FS;
    }
    Module.FS.mkdirTree(_config.homedir);
    Module.ENV.HOME = _config.homedir;
    Module.FS.chdir(_config.homedir);
    Module.ENV = Object.assign(Module.ENV, _config.REnv);
  });

  const chan = new ChannelWorker();

  Module.webr = {
    resolveInit: () => {
      chan.resolve();
      Module.setValue(Module._R_Interactive, _config.interactive, '*');
    },

    // C code must call `free()` on the result
    readConsole: () => {
      const input = inputOrDispatch(chan);
      return Module.allocateUTF8(input);
    },
  };

  Module.locateFile = (path: string) => _config.WEBR_URL + path;
  Module.downloadFileContent = downloadFileContent;

  Module.print = (text: string) => {
    chan.write({ type: 'stdout', data: text });
  };
  Module.printErr = (text: string) => {
    chan.write({ type: 'stderr', data: text });
  };
  Module.setPrompt = (prompt: string) => {
    chan.write({ type: 'prompt', data: prompt });
  };
  Module.canvasExec = (op: string) => {
    chan.write({ type: 'canvasExec', data: op });
  };

  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  (globalThis as any).Module = Module;

  // At the next tick, launch the REPL. This never returns.
  setTimeout(() => {
    const scriptSrc = `${_config.WEBR_URL}R.bin.js`;
    loadScript(scriptSrc);
  });
}
