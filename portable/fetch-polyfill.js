import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import PImage from 'pureimage';

// 1. DOMMatrix Polyfill for pdfjs-dist
export class SimpleDOMMatrix {
    constructor(init) {
        if (Array.isArray(init)) {
            this.a = init[0] ?? 1;
            this.b = init[1] ?? 0;
            this.c = init[2] ?? 0;
            this.d = init[3] ?? 1;
            this.e = init[4] ?? 0;
            this.f = init[5] ?? 0;
        } else if (typeof init === 'object' && init !== null) {
            this.a = init.a ?? 1;
            this.b = init.b ?? 0;
            this.c = init.c ?? 0;
            this.d = init.d ?? 1;
            this.e = init.e ?? 0;
            this.f = init.f ?? 0;
        } else {
            this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
        }
    }

    invertSelf() {
        const det = this.a * this.d - this.b * this.c;
        if (det === 0) return this;
        const a = this.d / det;
        const b = -this.b / det;
        const c = -this.c / det;
        const d = this.a / det;
        const e = (this.c * this.f - this.d * this.e) / det;
        const f = (this.b * this.e - this.a * this.f) / det;
        this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
        return this;
    }

    invert() {
        const copy = new SimpleDOMMatrix(this);
        return copy.invertSelf();
    }
}

if (typeof globalThis.DOMMatrix === 'undefined') {
    globalThis.DOMMatrix = SimpleDOMMatrix;
}

// 2. Polyfill for file:// URLs in fetch for Node.js (needed for pdfjs-dist WASM loading)
const originalFetch = globalThis.fetch;
globalThis.fetch = async function (url, options) {
    const urlStr = String(url);
    if (urlStr.startsWith('file://')) {
        const filePath = fileURLToPath(urlStr);
        const buffer = fs.readFileSync(filePath);
        return new Response(buffer, {
            status: 200,
            headers: { 'Content-Type': 'application/wasm' }
        });
    }
    return originalFetch(url, options);
};

export function polyfillPureContext(ctx, width, height) {
    if (!ctx.createImageData) {
        ctx.createImageData = function (w, h) {
            const width = Math.floor(w);
            const height = Math.floor(h);
            return {
                width: width,
                height: height,
                data: new Uint8ClampedArray(width * height * 4),
                calculateIndex: function (x, y) {
                    return (y * width + x) * 4;
                }
            };
        };
    }
    ctx.getTransform = function () {
        return new SimpleDOMMatrix(ctx._transform || [1, 0, 0, 1, 0, 0]);
    };
    return ctx;
}

export function createPolyfilledPureCanvas(w, h) {
    const canvas = PImage.make(Math.floor(w), Math.floor(h));
    const originalGetContext = canvas.getContext.bind(canvas);
    canvas.getContext = function (type) {
        const ctx = originalGetContext(type);
        if (type === '2d') {
            polyfillPureContext(ctx, w, h);
        }
        return ctx;
    };
    return canvas;
}

// 3. Intercept @napi-rs/canvas: Try real native canvas first, fallback to pureimage mock if AppLocker blocks DLL
const require = createRequire(import.meta.url);
try {
    const canvasPath = require.resolve('@napi-rs/canvas');
    // Try requiring real native canvas
    try {
        require(canvasPath);
        // Real canvas loaded without AppLocker error!
    } catch (dllError) {
        // AppLocker or DLOPEN error - fallback to polyfilled pureimage mock
        const mockCanvas = {
            createCanvas: (w, h) => createPolyfilledPureCanvas(w, h),
            loadImage: PImage.decodePNGFromStream,
            DOMMatrix: SimpleDOMMatrix
        };
        require.cache[canvasPath] = {
            id: canvasPath,
            filename: canvasPath,
            loaded: true,
            exports: mockCanvas
        };
    }
} catch (e) {
    // Ignore if module not found
}
