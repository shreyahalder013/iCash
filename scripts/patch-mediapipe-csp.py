#!/usr/bin/env python3
"""
patch-mediapipe-csp.py
======================
Patch MediaPipe Emscripten glue files to remove all eval-style function construction.
Replaces three sites in face_mesh_solution_wasm_bin.js and face_mesh_solution_simd_wasm_bin.js:

1. createNamedFunction: new Function("body", ...) -> {[name]:function(){...}}[name]
2. craftInvokerFunction: new_(Function, args1).apply(null, args2) -> direct closure (eval-free)
3. __emval_get_method_caller: new_(Function, params).apply(null, args) -> direct closure (eval-free)

The script is idempotent: if a file is already correctly patched it prints "already patched".
Exits non-zero if any site is found != 1 time in a file that needs patching.
Fails if `new Function` or `new_(Function` or Function.apply(null, args1Local) remain after patch.

NOTE: The replacements must NOT use Function() as a constructor or in any call that builds
code from strings. Both `new Function(...)` and `Function(...)` are eval-style.
"""

import re
import sys
from pathlib import Path

TARGET_FILES = [
    "models/face_mesh/face_mesh_solution_wasm_bin.js",
    "models/face_mesh/face_mesh_solution_simd_wasm_bin.js",
    "public/vendor/mediapipe/face_mesh_solution_wasm_bin.js",
    "public/vendor/mediapipe/face_mesh_solution_simd_wasm_bin.js",
]

# ─────────────────────────────────────────────────────────────────────────────
# 1. createNamedFunction
# ─────────────────────────────────────────────────────────────────────────────
OLD_NAMED = (
    'return new Function("body","return function "+name+"() {\\n"'
    '+"    \\"use strict\\";"'
    '+"    return body.apply(this, arguments);\\n"'
    '+"};\\n")(body)'
)
NEW_NAMED = 'return {[name]:function(){return body.apply(this,arguments)}}[name]'

# ─────────────────────────────────────────────────────────────────────────────
# 2. craftInvokerFunction (CORRECT closure replacement — no Function constructor)
# ─────────────────────────────────────────────────────────────────────────────
# Start marker for state A (original npm)
CRAFT_START = 'function craftInvokerFunction('
# End marker for state A (original npm)
CRAFT_END_A = 'var invokerFunction=new_(Function,args1).apply(null,args2);return invokerFunction}'
# End marker for state B (python-patched — still eval)
CRAFT_END_B = 'return invokerFunction}'

# The correct CSP-compliant replacement
NEW_CRAFT = (
    'function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc)'
    '{var argCount=argTypes.length;if(argCount<2){throwBindingError("argTypes array size mismatch!'
    ' Must at least get return value and \'this\' types!")}'
    'var isClassMethodFunc=argTypes[1]!==null&&classType!==null;'
    'var needsDestructorStack=false;'
    'for(var i=1;i<argTypes.length;++i){if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined)'
    '{needsDestructorStack=true;break}}'
    'var returns=argTypes[0].name!=="void";'
    'var nargs=argCount-2;var retType=argTypes[0];var classParam=argTypes[1];'
    'var fname=makeLegalFunctionName(humanName);'
    'return {[fname]:function(){'
    'if(arguments.length!==nargs){throwBindingError("function "+humanName+" called with "+arguments.length+" arguments, expected "+nargs+" args!")}'
    'var destructors=needsDestructorStack?[]:null;'
    'var thisWired;if(isClassMethodFunc){thisWired=classParam.toWireType(destructors,this)}'
    'var wired=new Array(nargs);'
    'for(var i=0;i<nargs;++i){wired[i]=argTypes[i+2].toWireType(destructors,arguments[i])}'
    'var callArgs=[cppTargetFunc];'
    'if(isClassMethodFunc){callArgs.push(thisWired)}'
    'for(var i=0;i<nargs;++i){callArgs.push(wired[i])}'
    'var rv=cppInvokerFunc.apply(null,callArgs);'
    'if(needsDestructorStack){runDestructors(destructors)}'
    'else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i)'
    '{if(argTypes[i].destructorFunction!==null){argTypes[i].destructorFunction(i===1?thisWired:wired[i-2])}}}'
    'if(returns){return retType.fromWireType(rv)}'
    '}}[fname]}'
)

# ─────────────────────────────────────────────────────────────────────────────
# 3. __emval_get_method_caller (CORRECT closure replacement — no Function constructor)
# ─────────────────────────────────────────────────────────────────────────────
EMVAL_START = 'function __emval_get_method_caller('
EMVAL_END_A = 'return __emval_addMethodCaller(invokerFunction)}'
# State B shares same end marker but has python-patch pattern before it

NEW_EMVAL = (
    'function __emval_get_method_caller(argCount,argTypes)'
    '{var types=__emval_lookupTypes(argCount,argTypes);'
    'var retType=types[0];'
    'var signatureName=retType.name+"_$"+types.slice(1).map(function(t){return t.name}).join("_")+"$";'
    'var n=argCount-1;'
    'var functionName=makeLegalFunctionName("methodCaller_"+signatureName);'
    'var invokerFunction={[functionName]:function(handle,name,destructors,args){'
    'var vals=[];var offset=0;'
    'for(var i=0;i<n;++i){vals.push(types[1+i].readValueFromPointer(args+offset));offset+=types[i+1]["argPackAdvance"]}'
    'var rv=handle[name].apply(handle,vals);'
    'for(var i=0;i<n;++i){if(types[i+1]["deleteObject"]){types[i+1].deleteObject(vals[i])}}'
    'if(!retType.isVoid){return retType.toWireType(destructors,rv)}'
    '}}[functionName];'
    'return __emval_addMethodCaller(invokerFunction)}'
)

# ─────────────────────────────────────────────────────────────────────────────
# Patterns that MUST NOT remain after patching
# ─────────────────────────────────────────────────────────────────────────────
FORBIDDEN_PATTERNS = [
    'new Function',
    'new_(Function',
    'Function.apply(null, args1Local)',   # old python-patch remnant
    'Function.apply(null, paramsLocal)',  # old python-patch remnant
]


def find_and_replace_function(content, start_marker, end_marker, replacement, label):
    """Find a function starting at start_marker and ending at end_marker, replace with replacement."""
    start_idx = content.find(start_marker)
    if start_idx == -1:
        return None, f"start marker not found for {label}"
    end_idx = content.find(end_marker, start_idx)
    if end_idx == -1:
        return None, f"end marker not found for {label} (start was at {start_idx})"
    return content[:start_idx] + replacement + content[end_idx + len(end_marker):], None


def patch_file(filepath):
    """
    Patch a single file. Returns status string: 'patched', 'already', or raises.
    """
    content = filepath.read_text(encoding='utf-8')
    original = content
    patched_what = []

    # ── 1. createNamedFunction ───────────────────────────────────────────────
    if 'new Function' in content:
        if OLD_NAMED not in content:
            raise RuntimeError(f"createNamedFunction: 'new Function' present but expected literal not found")
        count = content.count(OLD_NAMED)
        if count != 1:
            raise RuntimeError(f"createNamedFunction: expected 1 occurrence, found {count}")
        content = content.replace(OLD_NAMED, NEW_NAMED, 1)
        patched_what.append('createNamedFunction')
    elif '{[name]:function(){return body.apply(this,arguments)}}[name]' in content:
        pass  # already correct
    # else: may not exist in this version (ok)

    # ── 2. craftInvokerFunction ───────────────────────────────────────────────
    if '{[fname]:function()' in content:
        # Already correctly patched
        pass
    elif 'new_(Function,args1)' in content:
        # State A: original npm
        result, err = find_and_replace_function(content, CRAFT_START, CRAFT_END_A, NEW_CRAFT, 'craftInvokerFunction')
        if err:
            raise RuntimeError(err)
        content = result
        patched_what.append('craftInvokerFunction (state-A)')
    elif 'Function.apply(null, args1Local)' in content:
        # State B: python-patched (still eval) — replace whole function
        result, err = find_and_replace_function(content, CRAFT_START, CRAFT_END_B, NEW_CRAFT, 'craftInvokerFunction')
        if err:
            raise RuntimeError(err)
        content = result
        patched_what.append('craftInvokerFunction (state-B)')
    else:
        raise RuntimeError('craftInvokerFunction: unknown state — cannot identify pattern to patch')

    # ── 3. __emval_get_method_caller ─────────────────────────────────────────
    if '{[functionName]:function(' in content:
        # Already correctly patched
        pass
    elif 'new_(Function,params)' in content:
        # State A: original npm
        result, err = find_and_replace_function(content, EMVAL_START, EMVAL_END_A, NEW_EMVAL, '__emval_get_method_caller')
        if err:
            raise RuntimeError(err)
        content = result
        patched_what.append('__emval_get_method_caller (state-A)')
    elif 'Function.apply(null, paramsLocal)' in content:
        # State B: python-patched (still eval) — replace whole function
        result, err = find_and_replace_function(content, EMVAL_START, EMVAL_END_A, NEW_EMVAL, '__emval_get_method_caller')
        if err:
            raise RuntimeError(err)
        content = result
        patched_what.append('__emval_get_method_caller (state-B)')
    else:
        raise RuntimeError('__emval_get_method_caller: unknown state — cannot identify pattern to patch')

    # ── Verification ──────────────────────────────────────────────────────────
    for bad in FORBIDDEN_PATTERNS:
        if bad in content:
            raise RuntimeError(f"FORBIDDEN pattern still present after patch: '{bad}'")

    # ── Write ─────────────────────────────────────────────────────────────────
    if content != original:
        filepath.write_text(content, encoding='utf-8')
        print(f"  patched  {filepath}  ({', '.join(patched_what)})")
        return 'patched'
    else:
        print(f"  already patched  {filepath}")
        return 'already'


def main():
    print("Patching MediaPipe glue files for CSP compliance...")
    print()

    any_fail = False
    for rel_path in TARGET_FILES:
        filepath = Path(rel_path)
        if not filepath.exists():
            print(f"  SKIP  {rel_path}  (not found)")
            continue
        try:
            patch_file(filepath)
        except Exception as e:
            print(f"  ERROR  {rel_path}: {e}")
            any_fail = True

    print()
    if any_fail:
        print("ERROR: Some files failed — see above.")
        return 1
    print("All files patched successfully (or were already correct).")
    return 0


if __name__ == "__main__":
    sys.exit(main())