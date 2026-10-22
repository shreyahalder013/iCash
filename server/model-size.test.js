/**
 * Model Size Verification Test
 * Verifies that for every manifest in models/, the sum of prod(shape) * bytes-per-dtype
 * equals the size of the .bin files named in "paths".
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MODEL_MANIFESTS = [
    'models/tiny_face_detector_model-weights_manifest.json',
    'models/face_landmark_68_model-weights_manifest.json',
    'models/face_recognition_model-weights_manifest.json',
];

function getDtypeSize(dtype) {
    switch (dtype) {
        case 'float32': return 4;
        case 'uint8': return 1;
        case 'int32': return 4;
        case 'int8': return 1;
        case 'uint16': return 2;
        case 'int16': return 2;
        default: return 4; // default to 4 bytes
    }
}

describe('Model Size Verification', () => {
    MODEL_MANIFESTS.forEach(manifestPath => {
        it(`should match expected size for ${path.basename(manifestPath)}`, () => {
            const fullPath = path.resolve(manifestPath);
            expect(fs.existsSync(fullPath)).toBe(true);
            
            const manifest = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
            let expectedBytes = 0;
            
            manifest[0].weights.forEach(weight => {
                let shapeProduct = 1;
                weight.shape.forEach(dim => shapeProduct *= dim);
                
                // Use quantization dtype if available, otherwise use weight dtype
                const dtype = weight.quantization ? weight.quantization.dtype : weight.dtype;
                const dtypeSize = getDtypeSize(dtype);
                
                expectedBytes += shapeProduct * dtypeSize;
            });
            
            // Check all bin files listed in paths
            manifest[0].paths.forEach(binPath => {
                const fullBinPath = path.resolve(path.dirname(manifestPath), binPath);
                expect(fs.existsSync(fullBinPath)).toBe(true);
                
                const stats = fs.statSync(fullBinPath);
                expect(stats.size).toBe(expectedBytes);
            });
        });
    });
    
    it('should have all bin files present', () => {
        const allBinFiles = [
            'models/tiny_face_detector_model.bin',
            'models/face_landmark_68_model.bin',
            'models/face_recognition_model.bin',
            'public/vendor/mediapipe/face_recognition_model.bin',
        ];
        
        allBinFiles.forEach(binFile => {
            expect(fs.existsSync(binFile)).toBe(true);
        });
    });
});