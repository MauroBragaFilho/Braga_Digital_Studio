'use strict';

/**
 * Componentes baixados em tempo de execução (não empacotados), com licença e texto conferidos nos repositórios
 * oficiais (campo "source" = URLs consultadas). Para as licenças GPL/NVIDIA (muito longas) o texto integral está
 * no arquivo oficial indicado.
 */

const MIT = (holder) => `MIT License

Copyright ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const UNLICENSE = `This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <http://unlicense.org/>`;

const RUNTIME = [
  {
    id: 'rt-ffmpeg', name: 'FFmpeg', version: 'compilação mais recente da BtbN (variante GPL)', license: 'GPL-3.0-or-later',
    url: 'https://ffmpeg.org/', sourceUrl: 'https://ffmpeg.org/download.html',
    source: 'https://github.com/BtbN/FFmpeg-Builds/blob/master/variants/defaults-gpl.sh (FF_CONFIGURE="--enable-gpl --enable-version3", LICENSE_FILE="COPYING.GPLv3"); https://ffmpeg.org/legal.html',
    note: 'Usado para converter, cortar e analisar mídia. A compilação baixada (BtbN/FFmpeg-Builds, variante GPL) é construída com as opções de GPL versão 3, ou seja, GPL-3.0 ou posterior. O código-fonte está em ffmpeg.org e os scripts de compilação em github.com/BtbN/FFmpeg-Builds.',
    text: 'GNU General Public License, versão 3 (GPL-3.0-or-later), conforme o arquivo COPYING.GPLv3 que acompanha o FFmpeg.\nTexto completo: https://github.com/FFmpeg/FFmpeg/blob/master/COPYING.GPLv3\nSobre as condições de licença do FFmpeg: https://ffmpeg.org/legal.html\nCódigo-fonte: https://ffmpeg.org/download.html\nScripts da compilação usada: https://github.com/BtbN/FFmpeg-Builds'
  },
  { id: 'rt-ytdlp', name: 'yt-dlp', version: 'versão mais recente', license: 'Unlicense', url: 'https://github.com/yt-dlp/yt-dlp', source: 'https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/LICENSE', note: 'Usado para baixar vídeos e áudios.', text: UNLICENSE },
  { id: 'rt-spotdl', name: 'spotDL', version: 'versão mais recente', license: 'MIT', url: 'https://github.com/spotDL/spotify-downloader', source: 'https://raw.githubusercontent.com/spotDL/spotify-downloader/master/LICENSE', note: 'Usado para baixar músicas.', text: MIT('(c) 2021 spotDL Developers') },
  { id: 'rt-deno', name: 'Deno', version: 'versão mais recente', license: 'MIT', url: 'https://github.com/denoland/deno', source: 'https://raw.githubusercontent.com/denoland/deno/main/LICENSE.md', note: 'Ambiente de execução auxiliar do download.', text: MIT('2018-2026 the Deno authors') },
  {
    id: 'rt-untrunc', name: 'untrunc', version: 'versão mais recente (anthwlock)', license: 'GPL-2.0-only', url: 'https://github.com/anthwlock/untrunc',
    sourceUrl: 'https://github.com/anthwlock/untrunc', source: 'https://raw.githubusercontent.com/anthwlock/untrunc/master/COPYING (GNU GPL versão 2, junho de 1991; o texto do arquivo não traz cláusula "ou posterior")',
    note: 'Usado para recuperar vídeos danificados. O código-fonte está no repositório do projeto.',
    text: 'GNU General Public License, versão 2, junho de 1991 (arquivo COPYING do projeto).\nTexto completo: https://raw.githubusercontent.com/anthwlock/untrunc/master/COPYING\nCódigo-fonte: https://github.com/anthwlock/untrunc'
  },
  {
    id: 'rt-exiftool', name: 'ExifTool', version: 'versão mais recente', license: 'Artistic-1.0-Perl OR GPL-1.0-or-later', url: 'https://exiftool.org/', source: 'https://raw.githubusercontent.com/exiftool/exiftool/master/README', note: 'Usado para ler e gravar metadados.',
    text: 'Conforme o README do projeto: "This is free software; you can redistribute it and/or modify it under the same terms as Perl itself (either the Perl Artistic License or GPL)."\nTextos das licenças: https://dev.perl.org/licenses/\nCódigo-fonte: https://github.com/exiftool/exiftool'
  },
  { id: 'rt-whispercpp', name: 'whisper.cpp', version: 'versão fixada pelo aplicativo', license: 'MIT', url: 'https://github.com/ggml-org/whisper.cpp', source: 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/LICENSE', note: 'Usado para transcrever áudio.', text: MIT('(c) 2023-2026 The ggml authors') },
  { id: 'rt-whispermodels', name: 'Modelos de transcrição (OpenAI Whisper, formato ggml)', version: 'conforme o modelo escolhido', license: 'MIT', url: 'https://github.com/openai/whisper', source: 'https://raw.githubusercontent.com/openai/whisper/main/LICENSE; https://huggingface.co/ggerganov/whisper.cpp (License: mit)', note: 'Modelos de reconhecimento de fala baixados quando você escolhe um modelo de transcrição (hospedados em huggingface.co/ggerganov/whisper.cpp).', text: MIT('(c) 2022 OpenAI') },
  {
    id: 'rt-nvidia', name: 'Bibliotecas de aceleração NVIDIA (CUDA e cuBLAS)', version: 'CUDA 12.4', license: 'NVIDIA CUDA Toolkit EULA', url: 'https://docs.nvidia.com/cuda/eula/index.html',
    source: 'https://docs.nvidia.com/cuda/eula/index.html', note: 'Baixadas apenas se você ativar a aceleração NVIDIA (aceitando os termos da NVIDIA). Fazem parte do pacote oficial do motor de transcrição para placas NVIDIA.',
    text: 'Estas bibliotecas são software proprietário da NVIDIA, distribuídas sob o "CUDA Toolkit End User License Agreement" (os componentes redistribuíveis, como cuBLAS, podem ser incluídos em aplicativos conforme o Anexo A do contrato).\nTermos completos: https://docs.nvidia.com/cuda/eula/index.html'
  }
];

/**
 * Fontes empacotadas no aplicativo (renderer/assets/fonts), baixadas só dos repositórios oficiais de cada projeto.
 * Origem, versão e SHA-256 de cada arquivo: .docs/FONTES_ORIGEM.md. Licença: SIL Open Font License 1.1.
 */
const BUNDLED_FONTS = [
  { id: 'font-inter', name: 'Inter (fonte)', version: '4.1', license: 'OFL-1.1', url: 'https://github.com/rsms/inter', licenseFile: 'renderer/assets/fonts/OFL-Inter.txt' },
  { id: 'font-montserrat', name: 'Montserrat (fonte)', version: '7.222', license: 'OFL-1.1', url: 'https://github.com/JulietaUla/Montserrat', licenseFile: 'renderer/assets/fonts/OFL-Montserrat.txt' }
];

module.exports = { RUNTIME, BUNDLED_FONTS };
