import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { dirname, join } from 'path';
import https from 'https';

const MODEL_ID = 'Snowflake/snowflake-arctic-embed-s';
const MODEL_FILES = [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'onnx/model_quantized.onnx'
];

async function downloadFile(url, outputPath) {
    await fs.mkdir(dirname(outputPath), { recursive: true });

    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307) {
                // Handle redirect (some are relative paths, some are absolute)
                const redirectUrl = new URL(response.headers.location, url).href;
                downloadFile(redirectUrl, outputPath).then(resolve).catch(reject);
                return;
            }

            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download ${url}: ${response.statusCode}`));
                return;
            }

            const fileStream = createWriteStream(outputPath);
            response.pipe(fileStream);

            fileStream.on('finish', () => {
                fileStream.close();
                resolve();
            });

            fileStream.on('error', (err) => {
                fs.unlink(outputPath).catch(() => { }); // Cleanup on error
                reject(err);
            });
        }).on('error', reject);
    });
}

async function main() {
    const baseOutputDir = join(process.cwd(), 'public', 'models', MODEL_ID);

    console.log(`Downloading ${MODEL_ID} to ${baseOutputDir}...`);

    for (const file of MODEL_FILES) {
        const url = `https://huggingface.co/${MODEL_ID}/resolve/main/${file}`;
        const outputPath = join(baseOutputDir, file);

        try {
            await fs.access(outputPath);
            console.log(`Skipping ${file} - already exists.`);
        } catch {
            console.log(`Downloading ${file}...`);
            await downloadFile(url, outputPath);
        }
    }

    console.log('Model download complete.');

    // Copy the ORT WebGPU JSEP runtime files from the transformers package into
    // public/ort/ so the extension can serve them locally. Without this,
    // @huggingface/transformers falls back to loading them from CDN at runtime.
    const ortSrcDir = join(process.cwd(), 'node_modules', '@huggingface', 'transformers', 'dist');
    const ortDestDir = join(process.cwd(), 'public', 'ort');
    const ortFiles = [
        'ort-wasm-simd-threaded.jsep.mjs',
        'ort-wasm-simd-threaded.jsep.wasm',
    ];

    await fs.mkdir(ortDestDir, { recursive: true });
    for (const file of ortFiles) {
        await fs.copyFile(join(ortSrcDir, file), join(ortDestDir, file));
        console.log(`Copied ${file} → public/ort/`);
    }
}

main().catch((err) => {
    console.error('Error downloading model:', err);
    process.exit(1);
});
