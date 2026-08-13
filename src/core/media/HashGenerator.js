const crypto = require('crypto');
const fs = require('fs');

class HashGenerator {
    /**
     * Calcula o SHA256 de um arquivo usando streams.
     * Ideal para arquivos grandes de vídeo, para não carregar tudo na memória.
     * @param {string} filePath 
     * @returns {Promise<string>} Hash SHA256 em formato hexadecimal
     */
    static async generate(filePath) {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);

            stream.on('error', err => reject(err));
            stream.on('data', chunk => hash.update(chunk));
            stream.on('end', () => resolve(hash.digest('hex')));
        });
    }
}

module.exports = HashGenerator;
