const crypto = require('crypto');
const fs = require('fs');

const FULL_HASH_LIMIT = 5 * 1024 * 1024; // até este tamanho o hash cobre o arquivo inteiro
const FINGERPRINT_BLOCKS = 32;           // pontos amostrados pela impressão digital estendida
const FINGERPRINT_BLOCK_SIZE = 16 * 1024;

class HashGenerator {
    /** Tamanho até o qual generate() lê o arquivo completo (acima disso o hash é amostrado). */
    static get FULL_HASH_LIMIT() { return FULL_HASH_LIMIT; }

    /**
     * Impressão digital estendida (32 blocos de 16 KB espalhados pelo arquivo + tamanho), bem mais densa que a
     * amostragem de generate(). Só é usada para desempatar arquivos grandes cujo hash amostrado coincidiu.
     * @param {string} filePath
     * @returns {Promise<string>} SHA256 hexadecimal
     */
    static async extendedFingerprint(filePath) {
        const fh = await fs.promises.open(filePath, 'r');
        try {
            const { size } = await fh.stat();
            const hash = crypto.createHash('sha256');
            hash.update(Buffer.from(String(size)));
            const buf = Buffer.alloc(FINGERPRINT_BLOCK_SIZE);
            const span = Math.max(0, size - FINGERPRINT_BLOCK_SIZE);
            for (let i = 0; i < FINGERPRINT_BLOCKS; i++) {
                const pos = Math.floor((span * i) / (FINGERPRINT_BLOCKS - 1));
                const { bytesRead } = await fh.read(buf, 0, FINGERPRINT_BLOCK_SIZE, pos);
                hash.update(buf.subarray(0, bytesRead));
            }
            return hash.digest('hex');
        } finally {
            await fh.close().catch(() => {});
        }
    }

    /**
     * Calcula o hash SHA256 de um arquivo.
     * Para arquivos pequenos (<= 5MB), lê o arquivo completo.
     * Para arquivos grandes (> 5MB, vídeos/RAWs), gera um hash composto ultrarrápido
     * baseado no tamanho e blocos de 64KB (início, meio e fim), evitando travamentos de I/O.
     * @param {string} filePath 
     * @returns {Promise<string>} Hash SHA256 em formato hexadecimal
     */
    static async generate(filePath) {
        return new Promise((resolve, reject) => {
            fs.stat(filePath, (err, stats) => {
                if (err) return reject(err);

                const fileSize = stats.size;
                const SAMPLE_SIZE = 64 * 1024; // 64 KB

                // Se o arquivo for pequeno, gera o hash completo
                if (fileSize <= 5 * 1024 * 1024) {
                    const hash = crypto.createHash('sha256');
                    const stream = fs.createReadStream(filePath);
                    stream.on('error', streamErr => reject(streamErr));
                    stream.on('data', chunk => hash.update(chunk));
                    stream.on('end', () => resolve(hash.digest('hex')));
                    return;
                }

                // Arquivos grandes: hash composto por amostragem
                fs.open(filePath, 'r', (openErr, fd) => {
                    if (openErr) return reject(openErr);

                    const hash = crypto.createHash('sha256');
                    hash.update(Buffer.from(String(fileSize)));

                    const buf = Buffer.alloc(SAMPLE_SIZE);

                    // 1. Início do arquivo
                    fs.read(fd, buf, 0, SAMPLE_SIZE, 0, (rErr1, bytesRead1) => {
                        if (rErr1) { fs.close(fd, () => {}); return reject(rErr1); }
                        hash.update(buf.subarray(0, bytesRead1));

                        // 2. Meio do arquivo
                        const midPos = Math.max(0, Math.floor(fileSize / 2) - Math.floor(SAMPLE_SIZE / 2));
                        fs.read(fd, buf, 0, SAMPLE_SIZE, midPos, (rErr2, bytesRead2) => {
                            if (rErr2) { fs.close(fd, () => {}); return reject(rErr2); }
                            hash.update(buf.subarray(0, bytesRead2));

                            // 3. Fim do arquivo
                            const endPos = Math.max(0, fileSize - SAMPLE_SIZE);
                            fs.read(fd, buf, 0, SAMPLE_SIZE, endPos, (rErr3, bytesRead3) => {
                                fs.close(fd, () => {});
                                if (rErr3) return reject(rErr3);
                                hash.update(buf.subarray(0, bytesRead3));
                                resolve(hash.digest('hex'));
                            });
                        });
                    });
                });
            });
        });
    }
}

module.exports = HashGenerator;

