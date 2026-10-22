/* =========================================================
   ICASH — MediaPipe CSP patch (server middleware)

   MediaPipe's Emscripten glue builds functions from strings in 3 places
   (createNamedFunction, craftInvokerFunction, __emval_get_method_caller),
   which a CSP without 'unsafe-eval' blocks. This middleware rewrites those
   sites on the fly for any file named face_mesh_solution[_simd]_wasm_bin.js,
   wherever it lives under `rootDir`, so a stale or duplicate copy on disk can
   never reintroduce the error. Responses carry `X-CSP-Patched: mediapipe`.

   Mount it BEFORE express.static:
     app.use(mediapipeCspPatch(path.join(__dirname, '..')));
   ========================================================= */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OLD_NAMED = 'return new Function("body","return function "+name+"() {\\n"+\'    "use strict";\'+"    return body.apply(this, arguments);\\n"+"};\\n")(body)';
const NEW_NAMED = 'return {[name]:function(){return body.apply(this,arguments)}}[name]';

const NEW_CRAFT = String.raw`function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){var argCount=argTypes.length;if(argCount<2){throwBindingError("argTypes array size mismatch! Must at least get return value and 'this' types!")}var isClassMethodFunc=argTypes[1]!==null&&classType!==null;var needsDestructorStack=false;for(var i=1;i<argTypes.length;++i){if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined){needsDestructorStack=true;break}}var returns=argTypes[0].name!=="void";var nargs=argCount-2;var retType=argTypes[0];var classParam=argTypes[1];var fname=makeLegalFunctionName(humanName);return {[fname]:function(){if(arguments.length!==nargs){throwBindingError("function "+humanName+" called with "+arguments.length+" arguments, expected "+nargs+" args!")}var destructors=needsDestructorStack?[]:null;var thisWired;if(isClassMethodFunc){thisWired=classParam.toWireType(destructors,this)}var wired=new Array(nargs);for(var i=0;i<nargs;++i){wired[i]=argTypes[i+2].toWireType(destructors,arguments[i])}var callArgs=[cppTargetFunc];if(isClassMethodFunc){callArgs.push(thisWired)}for(var i=0;i<nargs;++i){callArgs.push(wired[i])}var rv=cppInvokerFunc.apply(null,callArgs);if(needsDestructorStack){runDestructors(destructors)}else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){if(argTypes[i].destructorFunction!==null){argTypes[i].destructorFunction(i===1?thisWired:wired[i-2])}}}if(returns){return retType.fromWireType(rv)}}}[fname]}`;

const NEW_EMVAL = String.raw`function __emval_get_method_caller(argCount,argTypes){var types=__emval_lookupTypes(argCount,argTypes);var retType=types[0];var signatureName=retType.name+"_$"+types.slice(1).map(function(t){return t.name}).join("_")+"$";var n=argCount-1;var functionName=makeLegalFunctionName("methodCaller_"+signatureName);var invokerFunction={[functionName]:function(handle,name,destructors,args){var vals=[];var offset=0;for(var i=0;i<n;++i){vals.push(types[1+i].readValueFromPointer(args+offset));offset+=types[i+1]["argPackAdvance"]}var rv=handle[name].apply(handle,vals);for(var i=0;i<n;++i){if(types[i+1]["deleteObject"]){types[i+1].deleteObject(vals[i])}}if(!retType.isVoid){return retType.toWireType(destructors,rv)}}}[functionName];return __emval_addMethodCaller(invokerFunction)}`;

function occurrences(s, needle) { let n = 0, i = -1; while ((i = s.indexOf(needle, i + 1)) !== -1) {n++;} return n; }

function replaceOnce(s, needle, replacement, what) {
  if (occurrences(s, needle) !== 1) {throw new Error(`${what}: expected exactly 1 match, found ${occurrences(s, needle)}`);}
  const i = s.indexOf(needle);
  return s.slice(0, i) + replacement + s.slice(i + needle.length);
}

function replaceFunction(s, start, end, replacement, what) {
  if (occurrences(s, start) !== 1) {throw new Error(`${what}: expected exactly 1 start match, found ${occurrences(s, start)}`);}
  const i = s.indexOf(start);
  const e = s.indexOf(end, i);
  if (e === -1) {throw new Error(`${what}: end marker not found`);}
  return s.slice(0, i) + replacement + s.slice(e + end.length);
}

/** @returns {{code:string, changed:string[]}} throws if an unknown glue version is encountered */
function patchGlue(src) {
  const changed = [];
  // Python-patched state: 'Function.apply(null, args1Local)' — STILL eval-style, needs real fix
  const CRAFT_END_PYTHON  = 'return invokerFunction}'; // end after python patch
  const EMVAL_END_PYTHON  = 'return __emval_addMethodCaller(invokerFunction)}';
  let s = src;
  // --- createNamedFunction (original npm state only) ---
  if (s.includes('new Function')) { s = replaceOnce(s, OLD_NAMED, NEW_NAMED, 'createNamedFunction'); changed.push('createNamedFunction'); }

  // --- craftInvokerFunction ---
  if (s.includes('new_(Function,args1)')) {
    // State A: original npm
    s = replaceFunction(s, 'function craftInvokerFunction(', 'var invokerFunction=new_(Function,args1).apply(null,args2);return invokerFunction}', NEW_CRAFT, 'craftInvokerFunction');
    changed.push('craftInvokerFunction');
  } else if (s.includes('Function.apply(null, args1Local)')) {
    // State B: Python-patched — still eval-style, replace whole function
    s = replaceFunction(s, 'function craftInvokerFunction(', CRAFT_END_PYTHON, NEW_CRAFT, 'craftInvokerFunction (python-state)');
    changed.push('craftInvokerFunction');
  }
  // else: already correctly patched with {[fname]:} — no-op

  // --- __emval_get_method_caller ---
  if (s.includes('new_(Function,params)')) {
    // State A: original npm
    s = replaceFunction(s, 'function __emval_get_method_caller(', 'return __emval_addMethodCaller(invokerFunction)}', NEW_EMVAL, '__emval_get_method_caller');
    changed.push('__emval_get_method_caller');
  } else if (s.includes('Function.apply(null, paramsLocal)')) {
    // State B: Python-patched — still eval-style, replace whole function
    s = replaceFunction(s, 'function __emval_get_method_caller(', EMVAL_END_PYTHON, NEW_EMVAL, '__emval_get_method_caller (python-state)');
    changed.push('__emval_get_method_caller');
  }
  // else: already correctly patched — no-op

  // Verify no eval patterns remain
  const left = ['new Function', 'new_(Function', 'Function.apply(null, args1Local)', 'Function.apply(null, paramsLocal)'].filter(p => s.includes(p));
  if (left.length) {throw new Error('dynamic code still present after patch: ' + left.join(', '));}
  return { code: s, changed };
}

const GLUE_RE = /(^|\/)face_mesh_solution(?:_simd)?_wasm_bin\.js$/;

function mediapipeCspPatch(rootDir, opts = {}) {
  const root = path.resolve(rootDir);
  const log = opts.logger || console;
  const cache = new Map(); // file -> { key, code, etag }
  return function (req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {return next();}
    let pathname = req.path;
    if (!pathname) { try { pathname = new URL(req.url, 'http://x').pathname; } catch { return next(); } }
    if (!GLUE_RE.test(pathname)) {return next();}
    let rel; try { rel = decodeURIComponent(pathname); } catch { return next(); }
    const file = path.join(root, rel);
    if (!file.startsWith(root + path.sep)) {return next();}            // no path traversal
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {return next();}                        // let static/404 handle it
      const key = st.mtimeMs + ':' + st.size;
      let hit = cache.get(file);
      if (!hit || hit.key !== key) {
        try {
          const { code, changed } = patchGlue(fs.readFileSync(file, 'utf8'));
          hit = { key, code, etag: '"' + crypto.createHash('sha1').update(code).digest('hex') + '"' };
          cache.set(file, hit);
          if (changed.length && log.warn) {log.warn(`[mediapipe-csp-patch] ${rel}: patched on the fly (${changed.join(', ')}). Consider committing the patched file.`);}
        } catch (e) {
          if (log.error) {log.error(`[mediapipe-csp-patch] ${rel}: ${e.message}`);}
          res.statusCode = 500; res.setHeader('Content-Type', 'text/plain'); return res.end('MediaPipe glue could not be made CSP-safe: ' + e.message);
        }
      }
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');                     // always revalidate; ETag makes it cheap
      res.setHeader('ETag', hit.etag);
      res.setHeader('X-CSP-Patched', 'mediapipe');
      if (req.headers['if-none-match'] === hit.etag) { res.statusCode = 304; return res.end(); }
      res.statusCode = 200;
      res.end(req.method === 'HEAD' ? undefined : hit.code);
    });
  };
}

module.exports = { mediapipeCspPatch, patchGlue };