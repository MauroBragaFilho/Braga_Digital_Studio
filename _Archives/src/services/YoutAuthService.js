const { spawn } = require('child_process');

class AuthService {
    conectarYoutube(event) {
        // Rodamos um comando simulado com oauth2
        const process = spawn('yt-dlp', [
            '--username', 'oauth2',
            '--simulate', 
            'https://www.youtube.com/watch?v=dQw4w9WgXcQ' // Vídeo dummy apenas para disparar o gatilho
        ]);

        process.stdout.on('data', (data) => {
            const output = data.toString();
            
            // Regex para capturar o código de autenticação gerado pelo yt-dlp
            const codeMatch = output.match(/enter code\s+([A-Z0-9-]+)/i);
            
            if (codeMatch) {
                const verificarCodigo = codeMatch[1];
                const urlVerificacao = "https://google.com/device";

                // Envia as informações direto para o Renderer através do evento IPC
                event.reply('youtube-esperando-autorizacao', {
                    url: urlVerificacao,
                    code: verificarCodigo
                });
            }
        });

        process.stderr.on('data', (data) => {
            const errorOutput = data.toString();
            // Se o usuário já estiver logado, o yt-dlp pode pular o passo do código
            if (errorOutput.includes('Logged in')) {
                event.reply('youtube-conectado-sucesso');
            }
        });

        process.on('close', (code) => {
            if (code === 0) {
                event.reply('youtube-conectado-sucesso');
            } else {
                event.reply('youtube-erro-conexao', 'O processo de autenticação foi fechado ou falhou.');
            }
        });
    }
}