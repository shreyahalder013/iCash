/**
 * Differential Test for MediaPipe CSP Patch
 *
 * Verifies that all MediaPipe glue files:
 *  1. Contain ZERO eval-style patterns (new Function, new_(Function, eval,
 *     Function.apply(null, args1Local), Function.apply(null, paramsLocal))
 *  2. Contain the correct semantics-preserving closure replacements
 *  3. Have valid JavaScript syntax
 *  4. The patchGlue() function in the middleware correctly handles
 *     both the original npm state and the (now obsolete) python-patched state
 *
 * IMPORTANT: The correct replacements use {[fname]:function(){...}}[fname]
 * NOT Function.apply(null, args1Local) which is STILL eval-style.
 */

import { describe, it, expect, _beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const GLUE_FILES = [
  'models/face_mesh/face_mesh_solution_wasm_bin.js',
  'models/face_mesh/face_mesh_solution_simd_wasm_bin.js',
  'public/vendor/mediapipe/face_mesh_solution_wasm_bin.js',
  'public/vendor/mediapipe/face_mesh_solution_simd_wasm_bin.js',
];

// These patterns are ALL eval-style — none should appear in a patched file.
const FORBIDDEN_PATTERNS = [
  { pattern: 'new Function(',     label: "new Function()" },
  { pattern: 'new_(Function',     label: "new_(Function,...)" },
  { pattern: 'eval(',             label: "eval()" },
  // The Python patch script incorrectly replaced new_(Function,...) with these —
  // they are STILL eval-style: Function() / Function.apply() builds from strings.
  { pattern: 'Function.apply(null, args1Local)',  label: 'Function.apply(null, args1Local) [python-patch-remnant]' },
  { pattern: 'Function.apply(null, paramsLocal)', label: 'Function.apply(null, paramsLocal) [python-patch-remnant]' },
];

// The correct semantics-preserving, eval-free patterns that MUST be present.
const REQUIRED_CRAFT_PATTERN   = '{[fname]:function()';   // craftInvokerFunction closure
const REQUIRED_EMVAL_PATTERN   = '{[functionName]:function('; // __emval_get_method_caller closure
const REQUIRED_NAMED_PATTERN   = 'return {[name]:function(){return body.apply(this,arguments)}}[name]';

describe('MediaPipe CSP Patch — Correctness (eval-free closures)', () => {

  describe('No eval-style patterns in any glue file', () => {
    GLUE_FILES.forEach(file => {
      it(`${path.basename(file)} must contain zero eval patterns`, () => {
        const content = fs.readFileSync(path.resolve(file), 'utf8');
        for (const { pattern, _label } of FORBIDDEN_PATTERNS) {
          const idx = content.indexOf(pattern);
          if (idx !== -1) {
            const ctx = content.substring(Math.max(0, idx - 60), idx + pattern.length + 60);
            throw new Error(
              `${file}: forbidden eval-style pattern "${label}" found at offset ${idx}.\n` +
              `Context: ...${ctx}...`
            );
          }
        }
      });
    });
  });

  describe('Correct closure replacements are present', () => {
    GLUE_FILES.forEach(file => {
      it(`${path.basename(file)} has eval-free craftInvokerFunction closure`, () => {
        const content = fs.readFileSync(path.resolve(file), 'utf8');
        expect(content).toContain(REQUIRED_CRAFT_PATTERN);
      });

      it(`${path.basename(file)} has eval-free __emval_get_method_caller closure`, () => {
        const content = fs.readFileSync(path.resolve(file), 'utf8');
        expect(content).toContain(REQUIRED_EMVAL_PATTERN);
      });

      it(`${path.basename(file)} has eval-free createNamedFunction`, () => {
        const content = fs.readFileSync(path.resolve(file), 'utf8');
        expect(content).toContain(REQUIRED_NAMED_PATTERN);
      });
    });
  });

  describe('JavaScript syntax validity', () => {
    GLUE_FILES.forEach(file => {
      it(`${path.basename(file)} is valid JavaScript`, () => {
        const content = fs.readFileSync(path.resolve(file), 'utf8');
        // eslint-disable-next-line no-new-func
        expect(() => new Function(content)).not.toThrow();
      });
    });
  });
});

describe('MediaPipe CSP Patch — patchGlue() middleware correctness', () => {
  let patchGlue;

  beforeAll(async () => {
    // Import the middleware's patchGlue for unit testing
    const mod = await import('../server/mediapipe-csp-patch.js');
    patchGlue = mod.patchGlue;
  });

  it('patchGlue on an already-correct file returns no changes', () => {
    // Use the actual patched file as input
    const src = fs.readFileSync(path.resolve('public/vendor/mediapipe/face_mesh_solution_wasm_bin.js'), 'utf8');
    const { code, changed } = patchGlue(src);
    // Already patched — should find no patterns to fix
    expect(changed).toHaveLength(0);
    expect(code).toBe(src); // unchanged
    // Verify still no forbidden patterns in output
    for (const { pattern, _label } of FORBIDDEN_PATTERNS) {
      expect(code).not.toContain(pattern);
    }
  });

  it('patchGlue on a python-patched file (state B) correctly replaces eval code', () => {
    // Simulate a file in "state B": already had new_(Function,...) replaced by the python
    // script with the incorrect Function.apply(null, args1Local) pattern.
    // Build a minimal synthetic state-B glue snippet.
    const stateB = [
      'function makeLegalFunctionName(n){return n}',
      'function throwBindingError(m){throw new Error(m)}',
      'function runDestructors(d){if(d)d.forEach(f=>f&&f())}',
      'function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){',
      '  var argCount=argTypes.length;',
      '  if(argCount<2){throwBindingError("argTypes array size mismatch! Must at least get return value and \'this\' types!")}',
      '  var isClassMethodFunc=argTypes[1]!==null&&classType!==null;',
      '  var needsDestructorStack=false;',
      '  for(var i=1;i<argTypes.length;++i){if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined){needsDestructorStack=true;break}}',
      '  var returns=argTypes[0].name!=="void";',
      '  var argsList="";var argsListWired="";',
      '  for(var i=0;i<argCount-2;++i){argsList+=(i!==0?", ":"")+("arg"+i);argsListWired+=(i!==0?", ":"")+("arg"+i+"Wired")}',
      '  var invokerFnBody="dummy";',
      '  var args1=["throwBindingError","invoker","fn","runDestructors","retType","classParam"];',
      '  var args2=[throwBindingError,cppInvokerFunc,cppTargetFunc,runDestructors,argTypes[0],argTypes[1]];',
      '  args1.push(invokerFnBody);',
      '  var invokerFunction = (function() {',
      '    var args1Local = args1;',
      '    var args2Local = args2;',
      '    return Function.apply(null, args1Local).apply(null, args2Local);',
      '  })();',
      '  return invokerFunction}',
    ].join('\n');

    // The middleware should detect state B and fix it
    const { code, changed } = patchGlue(stateB);
    expect(changed).toContain('craftInvokerFunction');
    // Verify the output has no forbidden patterns
    for (const { pattern, _label } of FORBIDDEN_PATTERNS) {
      if (code.includes(pattern)) {
        throw new Error(`patchGlue left forbidden pattern '${label}' in output`);
      }
    }
    // Should now have the correct closure
    expect(code).toContain(REQUIRED_CRAFT_PATTERN);
  });

  it('patchGlue on state-A (original npm) correctly patches craftInvokerFunction', () => {
    // Simulate a snippet with new_(Function,args1) which is the original npm state
    const stateA = [
      'function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){',
      '  var args1=["a","b"];var args2=[1,2];',
      '  args1.push("body");',
      '  var invokerFunction=new_(Function,args1).apply(null,args2);return invokerFunction}',
    ].join('\n');

    const { code, changed } = patchGlue(stateA);
    expect(changed).toContain('craftInvokerFunction');
    expect(code).not.toContain('new_(Function');
    expect(code).toContain(REQUIRED_CRAFT_PATTERN);
  });

  it('patchGlue output passes the forbidden-patterns check', () => {
    // Run patchGlue on each actual file and verify the output
    GLUE_FILES.forEach(file => {
      if (!fs.existsSync(path.resolve(file))) {return;}
      const src = fs.readFileSync(path.resolve(file), 'utf8');
      const { code } = patchGlue(src);
      for (const { pattern, _label } of FORBIDDEN_PATTERNS) {
        if (code.includes(pattern)) {
          throw new Error(`patchGlue(${file}) output contains forbidden '${label}'`);
        }
      }
    });
  });
});

describe('MediaPipe CSP Patch — Differential behavior verification', () => {
  /**
   * Test that the patched craftInvokerFunction closure behaves identically
   * to what the original function-string-builder would have produced,
   * using mock argTypes across many combinations.
   */
  it('craftInvokerFunction closure: wrong arg count throws correct message', () => {
    // Extract and run craftInvokerFunction from the patched glue
    const src = fs.readFileSync(path.resolve('public/vendor/mediapipe/face_mesh_solution_wasm_bin.js'), 'utf8');

    const throwMessages = [];
    function throwBindingError(msg) { throwMessages.push(msg); throw new Error(msg); }
    function makeLegalFunctionName(n) { return n.replace(/[^a-zA-Z0-9_]/g, '_'); }
    function runDestructors(_d) { }

    // Extract craftInvokerFunction body from the file
    const craftStart = src.indexOf('function craftInvokerFunction(');
    const craftEnd   = src.indexOf('function heap32VectorToArray', craftStart);
    const craftSrc   = src.substring(craftStart, craftEnd);

    // eslint-disable-next-line no-new-func
    const craftInvokerFunction = new Function(
      'throwBindingError', 'makeLegalFunctionName', 'runDestructors',
      `return (${craftSrc})`
    )(throwBindingError, makeLegalFunctionName, runDestructors);

    // Build mock argTypes for a void non-class method with 1 argument
    const _mockArg = {
      name: 'int',
      destructorFunction: null,
      toWireType: (_d, v) => v,
      fromWireType: v => v,
    };
    const voidType  = { name: 'void', destructorFunction: null, fromWireType: v => v };
    const intType   = { name: 'int',  destructorFunction: null, toWireType: (_d,v) => v, fromWireType: v => v };
    const mockInvoker = (fn, a) => a * 2;
    const mockTarget  = {};

    const argTypes = [voidType, null, intType]; // void return, no class, 1 arg
    const fn = craftInvokerFunction('testFunc', argTypes, null, mockInvoker, mockTarget);

    // Correct name
    expect(fn.name).toBe('testFunc');

    // Wrong arg count throws with correct message
    expect(() => fn()).toThrow('testFunc called with 0 arguments, expected 1');
    expect(() => fn(1, 2)).toThrow('testFunc called with 2 arguments, expected 1');
  });

  it('craftInvokerFunction closure: correct call returns value', () => {
    const src = fs.readFileSync(path.resolve('public/vendor/mediapipe/face_mesh_solution_wasm_bin.js'), 'utf8');
    function throwBindingError(msg) { throw new Error(msg); }
    function makeLegalFunctionName(n) { return n.replace(/[^a-zA-Z0-9_]/g, '_'); }
    function runDestructors() {}

    const craftStart = src.indexOf('function craftInvokerFunction(');
    const craftEnd   = src.indexOf('function heap32VectorToArray', craftStart);
    const craftSrc   = src.substring(craftStart, craftEnd);

    // eslint-disable-next-line no-new-func
    const craftInvokerFunction = new Function(
      'throwBindingError', 'makeLegalFunctionName', 'runDestructors',
      `return (${craftSrc})`
    )(throwBindingError, makeLegalFunctionName, runDestructors);

    const intType = {
      name: 'int',
      destructorFunction: null,
      toWireType: (_d, v) => v * 3,   // scale up on the way in
      fromWireType: v => v + 100,      // add 100 on the way out
    };
    // Non-void return, no class, 1 arg
    const mockInvoker = (_fn, wiredArg) => wiredArg + 7; // wiredArg = v*3, result = v*3+7
    const argTypes = [intType, null, intType];
    const fn = craftInvokerFunction('add', argTypes, null, mockInvoker, null);
    // fn(5) -> toWireType(5)=15 -> invoker(null,15)=22 -> fromWireType(22)=122
    expect(fn(5)).toBe(122);
  });
});