#!/usr/bin/env node
/**
 * apply-csp-fix.js
 * ================
 * One-shot script to directly patch all MediaPipe glue files on disk
 * with semantics-preserving, eval-free replacements.
 *
 * Handles two states:
 *   A. Original (npm): contains new_(Function,args1)  / new_(Function,params)
 *   B. Python-patched: contains Function.apply(null, args1Local) / Function.apply(null, paramsLocal)
 *
 * Both are replaced with the same correct closure-based approach.
 * Idempotent: re-running on already-fixed files is a no-op.
 */

const fs = require('fs');
const path = require('path');

const TARGET_FILES = [
  'public/vendor/mediapipe/face_mesh_solution_wasm_bin.js',
  'public/vendor/mediapipe/face_mesh_solution_simd_wasm_bin.js',
  'models/face_mesh/face_mesh_solution_wasm_bin.js',
  'models/face_mesh/face_mesh_solution_simd_wasm_bin.js',
];

// The correct CSP-compliant replacement for craftInvokerFunction.
// Replaces the entire body of the function starting at 'function craftInvokerFunction(' through
// the eval-style function construction, with a direct closure approach.
const NEW_CRAFT = `function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){var argCount=argTypes.length;if(argCount<2){throwBindingError("argTypes array size mismatch! Must at least get return value and 'this' types!")}var isClassMethodFunc=argTypes[1]!==null&&classType!==null;var needsDestructorStack=false;for(var i=1;i<argTypes.length;++i){if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined){needsDestructorStack=true;break}}var returns=argTypes[0].name!=="void";var nargs=argCount-2;var retType=argTypes[0];var classParam=argTypes[1];var fname=makeLegalFunctionName(humanName);return {[fname]:function(){if(arguments.length!==nargs){throwBindingError("function "+humanName+" called with "+arguments.length+" arguments, expected "+nargs+" args!")}var destructors=needsDestructorStack?[]:null;var thisWired;if(isClassMethodFunc){thisWired=classParam.toWireType(destructors,this)}var wired=new Array(nargs);for(var i=0;i<nargs;++i){wired[i]=argTypes[i+2].toWireType(destructors,arguments[i])}var callArgs=[cppTargetFunc];if(isClassMethodFunc){callArgs.push(thisWired)}for(var i=0;i<nargs;++i){callArgs.push(wired[i])}var rv=cppInvokerFunc.apply(null,callArgs);if(needsDestructorStack){runDestructors(destructors)}else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){if(argTypes[i].destructorFunction!==null){argTypes[i].destructorFunction(i===1?thisWired:wired[i-2])}}}if(returns){return retType.fromWireType(rv)}}}[fname]}`;

// The correct CSP-compliant replacement for __emval_get_method_caller.
const NEW_EMVAL = `function __emval_get_method_caller(argCount,argTypes){var types=__emval_lookupTypes(argCount,argTypes);var retType=types[0];var signatureName=retType.name+"_$"+types.slice(1).map(function(t){return t.name}).join("_")+"$";var n=argCount-1;var functionName=makeLegalFunctionName("methodCaller_"+signatureName);var invokerFunction={[functionName]:function(handle,name,destructors,args){var vals=[];var offset=0;for(var i=0;i<n;++i){vals.push(types[1+i].readValueFromPointer(args+offset));offset+=types[i+1]["argPackAdvance"]}var rv=handle[name].apply(handle,vals);for(var i=0;i<n;++i){if(types[i+1]["deleteObject"]){types[i+1].deleteObject(vals[i])}}if(!retType.isVoid){return retType.toWireType(destructors,rv)}}}[functionName];return __emval_addMethodCaller(invokerFunction)}`;

// Needles for the ORIGINAL npm version (new_(Function,...))
const ORIG_CRAFT_START = 'function craftInvokerFunction(';
const ORIG_CRAFT_END_A = 'var invokerFunction=new_(Function,args1).apply(null,args2);return invokerFunction}';

const ORIG_EMVAL_START = 'function __emval_get_method_caller(';
const ORIG_EMVAL_END_A = 'return __emval_addMethodCaller(invokerFunction)}';

// Needles for the PYTHON-patched version (Function.apply(null, args1Local)...)
// These are the exact strings currently in the files
const PY_CRAFT_NEEDLE = 'args1.push(invokerFnBody);\r\n    \r\n    var invokerFunction = (function() {\r\n        var args1Local = args1;\r\n        var args2Local = args2;\r\n        return Function.apply(null, args1Local).apply(null, args2Local);\r\n    })();\r\n    return invokerFunction}';

const PY_EMVAL_NEEDLE = 'params.push(functionBody);\r\n    \r\n    var invokerFunction = (function() {\r\n        var paramsLocal = params;\r\n        var argsLocal = args;\r\n        return Function.apply(null, paramsLocal).apply(null, argsLocal);\r\n    })();\r\n    return __emval_addMethodCaller(invokerFunction)}';

// The craft replacement for the already-fixed state (suffix of NEW_CRAFT starting from args1.push)
const FIXED_CRAFT_SUFFIX = 'args1.push(invokerFnBody)}'; // marker that our patch is in place

function replaceOnce(s, needle, replacement, label) {
  const count = s.split(needle).length - 1;
  if (count === 0) return null; // not found
  if (count > 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  return s.replace(needle, replacement);
}

function patchFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    console.log(`  SKIP  ${filePath} (not found)`);
    return 'skip';
  }

  let src = fs.readFileSync(abs, 'utf8');
  const origSrc = src;

  // Check if already correctly patched (closure with [fname]: pattern)
  if (src.includes('{[fname]:function()') && src.includes('{[functionName]:function(')) {
    console.log(`  ALREADY PATCHED  ${filePath}`);
    // Final verification
    if (src.includes('Function.apply(null, args1Local)') || src.includes('Function.apply(null, paramsLocal)')) {
      console.log(`  WARNING: ${filePath} appears partially patched — re-patching`);
    } else {
      return 'already';
    }
  }

  let patchedCraft = false;
  let patchedEmval = false;

  // --- Patch craftInvokerFunction ---
  if (src.includes('new_(Function,args1)')) {
    // State A: original npm version
    const startIdx = src.indexOf(ORIG_CRAFT_START);
    const endIdx = src.indexOf(ORIG_CRAFT_END_A, startIdx);
    if (startIdx === -1 || endIdx === -1) throw new Error(`${filePath}: craftInvokerFunction markers not found (state A)`);
    src = src.slice(0, startIdx) + NEW_CRAFT + src.slice(endIdx + ORIG_CRAFT_END_A.length);
    patchedCraft = true;
  } else if (src.includes('Function.apply(null, args1Local)')) {
    // State B: Python-patched version — replace the whole function range
    // Find start of the function
    const startIdx = src.indexOf(ORIG_CRAFT_START);
    // Find end: the closing brace of the craftInvokerFunction which is right after 'return invokerFunction}'
    const marker = 'return invokerFunction}';
    const markerIdx = src.indexOf(marker, startIdx);
    if (startIdx === -1 || markerIdx === -1) throw new Error(`${filePath}: craftInvokerFunction markers not found (state B)`);
    src = src.slice(0, startIdx) + NEW_CRAFT + src.slice(markerIdx + marker.length);
    patchedCraft = true;
  } else if (src.includes('{[fname]:function()')) {
    // Already correctly patched
    console.log(`  craftInvokerFunction: already correctly patched`);
  } else {
    throw new Error(`${filePath}: craftInvokerFunction: unknown state — cannot patch`);
  }

  // --- Patch __emval_get_method_caller ---
  if (src.includes('new_(Function,params)')) {
    // State A: original npm version
    const startIdx = src.indexOf(ORIG_EMVAL_START);
    // Find the closing: 'return __emval_addMethodCaller(invokerFunction)}'
    const endMarker = 'return __emval_addMethodCaller(invokerFunction)}';
    const endIdx = src.indexOf(endMarker, startIdx);
    if (startIdx === -1 || endIdx === -1) throw new Error(`${filePath}: __emval_get_method_caller markers not found (state A)`);
    src = src.slice(0, startIdx) + NEW_EMVAL + src.slice(endIdx + endMarker.length);
    patchedEmval = true;
  } else if (src.includes('Function.apply(null, paramsLocal)')) {
    // State B: Python-patched version — replace whole function range
    const startIdx = src.indexOf(ORIG_EMVAL_START);
    const endMarker = 'return __emval_addMethodCaller(invokerFunction)}';
    const endIdx = src.indexOf(endMarker, startIdx);
    if (startIdx === -1 || endIdx === -1) throw new Error(`${filePath}: __emval_get_method_caller markers not found (state B)`);
    src = src.slice(0, startIdx) + NEW_EMVAL + src.slice(endIdx + endMarker.length);
    patchedEmval = true;
  } else if (src.includes('{[functionName]:function(')) {
    console.log(`  __emval_get_method_caller: already correctly patched`);
  } else {
    throw new Error(`${filePath}: __emval_get_method_caller: unknown state — cannot patch`);
  }

  // --- Verify no eval patterns remain ---
  const bad = ['new Function', 'new_(Function', 'Function.apply(null, args1Local)', 'Function.apply(null, paramsLocal)'];
  for (const b of bad) {
    if (src.includes(b)) throw new Error(`${filePath}: eval pattern still present after patch: '${b}'`);
  }

  if (src !== origSrc) {
    fs.writeFileSync(abs, src, 'utf8');
    const what = [patchedCraft && 'craftInvokerFunction', patchedEmval && '__emval_get_method_caller'].filter(Boolean);
    console.log(`  PATCHED  ${filePath}  (${what.join(', ')})`);
    return 'patched';
  } else {
    console.log(`  NO CHANGE  ${filePath}`);
    return 'already';
  }
}

let anyFail = false;
for (const f of TARGET_FILES) {
  try {
    patchFile(f);
  } catch (e) {
    console.error(`  ERROR  ${f}: ${e.message}`);
    anyFail = true;
  }
}

if (anyFail) {
  console.error('\nSome files failed to patch.');
  process.exit(1);
} else {
  console.log('\nAll files patched successfully (or were already correct).');
  process.exit(0);
}
