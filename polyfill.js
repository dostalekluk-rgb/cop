import fs from 'fs';
import { fileURLToPath } from 'url';

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

console.log('Fetch polyfilled in polyfill.js!');
