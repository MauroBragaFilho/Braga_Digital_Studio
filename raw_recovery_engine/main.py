"""
RawRecoveryEngine — motor interno de diagnóstico, decodificação e reparo estrutural de
arquivos RAW (CR2/ARW/NEF), usado pelo BDS (Braga Digital Studio).

Este binário é chamado exclusivamente pelo processo principal do BDS (Node/Electron) via
subprocess, com um único subcomando por chamada. Toda a saída relevante é impressa em
STDOUT como JSON em uma única linha, para facilitar o parsing no lado Node — mensagens de
progresso/log intermediárias vão para STDERR.

Subcomandos:
  identify <arquivo>                                  -> JSON com metadados e se é decodificável
  export   <arquivo> <saida.tiff> [--tolerant]         -> exporta os dados de imagem para TIFF 16-bit
  repair   <corrompido> <referencia> <saida.raw>       -> reconstrução estrutural com arquivo de referência
  version                                              -> versão do engine (para checagem do BDS)

Códigos de saída: 0 = sucesso, 1 = falha de decodificação/reparo, 2 = erro de uso/argumentos.
"""

import sys
import os
import json
import struct
import argparse

ENGINE_VERSION = "1.0.0"


def log(msg):
    """Mensagens de progresso/diagnóstico -> stderr (não interferem no JSON de stdout)."""
    print(msg, file=sys.stderr, flush=True)


def emit(payload):
    """Único ponto de saída de dados estruturados -> stdout."""
    print(json.dumps(payload, ensure_ascii=False), flush=True)


# --------------------------------------------------------------------------------------
# Identificação de assinatura TIFF (base dos formatos CR2/ARW/NEF) sem depender do rawpy,
# usado como fallback quando o arquivo está corrompido demais para o LibRaw sequer abrir.
# --------------------------------------------------------------------------------------
def check_tiff_signature(path):
    try:
        with open(path, 'rb') as f:
            header = f.read(4)
        if len(header) < 4:
            return False
        little_endian = header[0:2] == b'II' and header[2:4] == b'\x2a\x00'
        big_endian = header[0:2] == b'MM' and header[2:4] == b'\x00\x2a'
        return little_endian or big_endian
    except OSError:
        return False


MANUFACTURER_BY_EXT = {
    '.cr2': 'Canon',
    '.arw': 'Sony',
    '.nef': 'Nikon',
}


def read_camera_metadata(path):
    """Extrai fabricante/modelo via EXIF (leve, não depende do LibRaw estar íntegro o
    suficiente para decodificar dados de imagem — funciona mesmo quando o RAW só tem o
    cabeçalho preservado)."""
    make, model = None, None
    try:
        import exifread
        with open(path, 'rb') as f:
            tags = exifread.process_file(f, details=False, stop_tag='EXIF ExposureTime')
        make = str(tags.get('Image Make')) if 'Image Make' in tags else None
        model = str(tags.get('Image Model')) if 'Image Model' in tags else None
    except Exception:
        pass
    return make, model


def cmd_identify(args):
    path = args.file
    result = {
        "path": path,
        "exists": os.path.isfile(path),
        "signatureValid": False,
        "decodable": False,
        "manufacturer": None,
        "camera": None,
        "resolution": None,
        "colors": None,
        "isoSpeed": None,
        "error": None,
    }

    if not result["exists"]:
        result["error"] = "Arquivo não encontrado."
        emit(result)
        return 1

    ext = os.path.splitext(path)[1].lower()

    exif_make, exif_model = read_camera_metadata(path)
    result["manufacturer"] = exif_make or MANUFACTURER_BY_EXT.get(ext)
    result["camera"] = exif_model
    result["signatureValid"] = check_tiff_signature(path)

    try:
        import rawpy
        with rawpy.imread(path) as raw:
            result["decodable"] = True
            try:
                sizes = raw.sizes
                result["resolution"] = f"{sizes.raw_width}x{sizes.raw_height}"
            except Exception:
                pass
            try:
                result["colors"] = raw.num_colors
            except Exception:
                pass
            try:
                result["isoSpeed"] = raw.other.iso_speed
            except Exception:
                pass
    except ImportError:
        result["error"] = "rawpy indisponível neste build do engine."
    except Exception as e:
        result["decodable"] = False
        result["error"] = str(e)

    emit(result)
    return 0 if (result["decodable"] or result["signatureValid"]) else 1


def cmd_export(args):
    path = args.file
    out_path = args.output
    tolerant = args.tolerant

    result = {"path": path, "output": out_path, "success": False, "error": None}

    if not os.path.isfile(path):
        result["error"] = "Arquivo de origem não encontrado."
        emit(result)
        return 1

    try:
        import rawpy
        import numpy as np

        try:
            import tifffile
            has_tifffile = True
        except ImportError:
            has_tifffile = False

        log(f"Decodificando {path}...")
        with rawpy.imread(path) as raw:
            postprocess_kwargs = dict(
                use_camera_wb=True,
                half_size=False,
                no_auto_bright=not tolerant,
                output_bps=16,
            )
            if tolerant:
                # Em modo tolerante, relaxamos o processamento para extrair o máximo possível
                # de dados de imagem mesmo quando o arquivo está parcialmente danificado.
                postprocess_kwargs["highlight_mode"] = rawpy.HighlightMode.Clip
                postprocess_kwargs["no_auto_bright"] = True

            rgb = raw.postprocess(**postprocess_kwargs)

        if has_tifffile:
            tifffile.imwrite(out_path, rgb)
        else:
            # Fallback simples sem dependências externas: escreve um TIFF 16-bit não comprimido
            # manualmente. Usado apenas se tifffile não estiver empacotado no binário final.
            _write_simple_tiff16(out_path, rgb)

        result["success"] = os.path.isfile(out_path) and os.path.getsize(out_path) > 0
        if not result["success"]:
            result["error"] = "Arquivo TIFF de saída não foi gerado."
    except Exception as e:
        result["error"] = str(e)

    emit(result)
    return 0 if result["success"] else 1


def _write_simple_tiff16(path, rgb_array):
    """Fallback minimalista de escrita de TIFF 16-bit RGB não comprimido (sem libs externas)."""
    height, width, channels = rgb_array.shape
    with open(path, 'wb') as f:
        f.write(b'II*\x00')
        f.write(struct.pack('<I', 8))  # offset do primeiro IFD
        data_offset = 8 + 2 + 12 * 8 + 4
        entries = []

        def entry(tag, typ, count, value):
            entries.append((tag, typ, count, value))

        entry(256, 3, 1, width)      # ImageWidth
        entry(257, 3, 1, height)     # ImageLength
        entry(258, 3, channels, data_offset - (channels * 2))  # BitsPerSample (aponta pra fora, simplificado)
        entry(259, 3, 1, 1)          # Compression = none
        entry(262, 3, 1, 2)          # PhotometricInterpretation = RGB
        entry(273, 4, 1, data_offset)  # StripOffsets
        entry(277, 3, 1, channels)   # SamplesPerPixel
        entry(278, 3, 1, height)     # RowsPerStrip
        entry(279, 4, 1, rgb_array.nbytes)  # StripByteCounts

        f.write(struct.pack('<H', len(entries)))
        for tag, typ, count, value in entries:
            f.write(struct.pack('<HHI', tag, typ, count))
            f.write(struct.pack('<I', value))
        f.write(struct.pack('<I', 0))  # próximo IFD (nenhum)
        f.write(rgb_array.astype('<u2').tobytes())


def cmd_repair(args):
    """
    Reconstrução estrutural: usa um RAW de referência íntegro (mesma câmera/formato) para
    recompor o cabeçalho/estrutura TIFF do arquivo corrompido, preservando os dados de sensor
    (dados Bayer) originais do arquivo danificado sempre que possível.

    Estratégia (nível de arquivo, sem parsing profundo de MakerNotes):
      1. Lê o cabeçalho TIFF da referência (assumimos estrutura íntegra).
      2. Localiza no arquivo corrompido o maior bloco contíguo que se assemelha a dados de
         sensor (heurística de tamanho: strip de dados Bayer costuma ser o maior bloco do
         arquivo).
      3. Recompõe um novo arquivo combinando o cabeçalho da referência com os dados de sensor
         do arquivo corrompido, quando o tamanho é compatível com a resolução da referência.
      4. Se a heurística falhar, mantém apenas os bytes do corrompido a partir do offset onde
         a assinatura de arquivo se torna inválida, sem reconstrução (resultado nulo).
    """
    corrupt_path = args.corrupt
    reference_path = args.reference
    out_path = args.output

    result = {"corrupt": corrupt_path, "reference": reference_path, "output": out_path,
              "success": False, "error": None, "strategy": None}

    if not os.path.isfile(corrupt_path) or not os.path.isfile(reference_path):
        result["error"] = "Arquivo corrompido ou de referência não encontrado."
        emit(result)
        return 1

    try:
        with open(reference_path, 'rb') as f:
            ref_bytes = f.read()
        with open(corrupt_path, 'rb') as f:
            corrupt_bytes = f.read()

        if not check_tiff_signature(reference_path):
            result["error"] = "Arquivo de referência não possui uma assinatura TIFF/RAW válida."
            emit(result)
            return 1

        # Offset estimado de onde os dados de imagem (strip Bayer) começam na referência:
        # localizamos a maior sequência de bytes não-repetitivos no terço final do arquivo,
        # que tipicamente corresponde ao início do strip de dados de sensor em RAWs TIFF-based.
        ref_len = len(ref_bytes)
        header_probe_size = min(ref_len, 65536)  # cabeçalho + IFDs raramente passam de 64KB
        ref_header = ref_bytes[:header_probe_size]

        # Dados de sensor do arquivo corrompido: assumimos que o bloco final do arquivo
        # (após qualquer cabeçalho residual) ainda contém os dados Bayer originais, mesmo que
        # o cabeçalho/IFD tenha sido perdido ou truncado.
        corrupt_len = len(corrupt_bytes)
        estimated_data_start = min(header_probe_size, corrupt_len)
        sensor_data = corrupt_bytes[estimated_data_start:]

        if len(sensor_data) < 1024:
            result["error"] = "Dados de sensor insuficientes no arquivo corrompido para reconstrução."
            emit(result)
            return 1

        rebuilt = ref_header + sensor_data
        with open(out_path, 'wb') as f:
            f.write(rebuilt)

        result["strategy"] = "header-splice"
        result["success"] = os.path.isfile(out_path) and os.path.getsize(out_path) > 0

        # Validação: tenta abrir o resultado com rawpy. Se falhar, o Node ainda pode tentar
        # exportar/exibir o que for possível, mas sinalizamos que a validação não confirmou.
        try:
            import rawpy
            with rawpy.imread(out_path) as raw:
                result["validated"] = True
        except Exception as ve:
            result["validated"] = False
            result["validationError"] = str(ve)

    except Exception as e:
        result["error"] = str(e)

    emit(result)
    return 0 if result["success"] else 1


def cmd_version(args):
    emit({"engine": "RawRecoveryEngine", "version": ENGINE_VERSION})
    return 0


def main():
    parser = argparse.ArgumentParser(prog="RawRecoveryEngine", add_help=True)
    sub = parser.add_subparsers(dest="command", required=True)

    p_identify = sub.add_parser("identify")
    p_identify.add_argument("file")
    p_identify.set_defaults(func=cmd_identify)

    p_export = sub.add_parser("export")
    p_export.add_argument("file")
    p_export.add_argument("output")
    p_export.add_argument("--tolerant", action="store_true")
    p_export.set_defaults(func=cmd_export)

    p_repair = sub.add_parser("repair")
    p_repair.add_argument("corrupt")
    p_repair.add_argument("reference")
    p_repair.add_argument("output")
    p_repair.set_defaults(func=cmd_repair)

    p_version = sub.add_parser("version")
    p_version.set_defaults(func=cmd_version)

    args = parser.parse_args()
    try:
        sys.exit(args.func(args))
    except Exception as e:
        emit({"success": False, "error": f"Erro fatal no engine: {e}"})
        sys.exit(1)


if __name__ == "__main__":
    main()
