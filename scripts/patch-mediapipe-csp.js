#!/usr/bin/env node
/**
 * Patch MediaPipe glue files to remove new Function (eval-style) for CSP compatibility.
 * Replaces:
 *   return new Function("body","return function "+name+"() {\n"+'    "use strict";'+"    return body.apply(this, arguments);\n"+"};\n")(body)
 * with:
 *   return {[name]:function(){return body.apply(this,arguments)}}[name]
 */

const fs = require('fs');
const path = require('path');

const TARGET_FILES = [
    'models/face_mesh/face_mesh_solution_wasm_bin.js',
    'models/face_mesh/face_mesh_solution_simd_wasm_bin.js'
];

const SEARCH_PATTERN = 'createNamedFunction(name,body){name=makeLegalFunctionName(name);return new Function("body","return function "+name+"() {\\n"+\'    "use strict";\'+"    return body.apply(this, arguments);\\n"+"};\\n")(body)}';
const REPLACEMENT = 'createNamedFunction(name,body){name=makeLegalFunctionName(name);return {[name]:function(){return body.apply(this,arguments)}}[name]}';

function patchFile(filePath) {
    const fullPath = path.join(__dirname, '..', filePath);
    if (!fs.existsSync(fullPath)) {
        throw new Error(`File not found: ${fullPath}`);
    }

    let content = fs.readFileSync(fullPath, 'utf8');

    // Count occurrences before patch
    const beforeCount = (content.match(/new Function/g) || []).length;
    console.log(`  ${filePath}: ${beforeCount} 'new Function' before patch`);

    if (!content.includes(SEARCH_PATTERN)) {
        throw new Error(`Pattern not found in ${filePath}. File may have been modified or minified differently.`);
    }

    // Apply patch
    content = content.replace(SEARCH_PATTERN, REPLACEMENT);

    // Count occurrences after patch
    const afterCount = (content.match(/new Function/g) || []).length;
    console.log(`  ${filePath}: ${afterCount} 'new Function' after patch`);

    if (afterCount !== 0) {
        throw new Error(`Patch failed: ${filePath} still has ${afterCount} 'new Function' occurrences`);
    }

    // Verify syntax with node --check
    try {
        require('child_process').execSync(`node --check "${fullPath}"`, { stdio: 'pipe', cwd: path.dirname(fullPath) });
        console.log(`  ${filePath}: Syntax check passed`);
    } catch (e) {
        throw new Error(`Syntax check failed for ${filePath}: ${e.message}`);
    }

    // Write patched file
    fs.writeFileSync(fullPath, content, 'utf8');
    console.log(`  ${filePath}: Patched successfully`);
}

function main() {
    console.log('Patching MediaPipe glue files for CSP compatibility...');
    let allSuccess = true;

    for (const file of TARGET_FILES) {
        try {
            patchFile(file);
        } catch (e) {
            console.error(`FAILED: ${file}: ${e.message}`);
            allSuccess = false;
        }
    }

    if (allSuccess) {
        console.log('\nAll files patched successfully!');
        process.exit(0);
    } else {
        console.error('\nSome files failed to patch!');
        process.exit(1);
    }
}

main();