const { FtpSrv } = require('ftp-srv');
const path = require('path');
const fs = require('fs');

class FtpService {
    constructor() {
        this.ftpServer = null;
        this.port = 2121; // Default port
    }

    start(ftpDir) {
        if (!fs.existsSync(ftpDir)) {
            fs.mkdirSync(ftpDir, { recursive: true });
        }

        const hostname = '0.0.0.0'; // Listen on all interfaces

        this.ftpServer = new FtpSrv({
            url: `ftp://${hostname}:${this.port}`,
            pasv_url: hostname,
            anonymous: true,
            greeting: ['Welcome to Braga Digital Studio FTP Server', 'Ready to receive files']
        });

        this.ftpServer.on('login', ({ connection, username, password }, resolve, reject) => {
            // Permitir acesso anônimo para a Sony a6000
            resolve({ root: ftpDir });
            
            connection.on('STOR', (error, fileName) => {
                if (error) {
                    console.error(`[FTP] Erro ao receber arquivo ${fileName}:`, error);
                } else {
                    console.log(`[FTP] Arquivo recebido com sucesso: ${fileName}`);
                }
            });
        });

        this.ftpServer.listen().then(() => {
            console.log(`[FTP] Servidor iniciado em ftp://${hostname}:${this.port}`);
            console.log(`[FTP] Diretório raiz: ${ftpDir}`);
        }).catch(err => {
            console.error(`[FTP] Falha ao iniciar servidor:`, err);
        });
    }

    stop() {
        if (this.ftpServer) {
            this.ftpServer.close();
            console.log('[FTP] Servidor parado.');
        }
    }
}

module.exports = new FtpService();
