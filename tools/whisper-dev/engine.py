"""Motor de transcrição SOMENTE PARA DESENVOLVIMENTO.

Fala o mesmo contrato do WhisperLegendas.exe (veja src/core/modules/README.md), mas usa o Python
com faster-whisper do projeto "Whisper + LM Studio" em vez do motor empacotado. Assim o módulo de
transcrição do BDS pode ser testado sem publicar o motor. Não é empacotado no instalador.

    python engine.py --cli jobs [--srt] [--md] [--cpu] [--saida DIR] [--palavras N] [--linhas N] <arquivos...>

Variáveis de ambiente:
    WL_MODEL_DIR     pasta do modelo faster-whisper (com model.bin)        [obrigatória]
    WL_LOG           arquivo onde o progresso é gravado (formato do contrato)
    WL_FORCE_CPU     "1" força a CPU
    WL_CUDA_DIR      pasta extra com DLLs do CUDA (opcional)
    WL_DEV_PROJECT   pasta do projeto "Whisper + LM Studio" (reaproveita legendar.py)  [obrigatória]
    WL_FFMPEG        caminho do ffmpeg (padrão: o do PATH)
    WL_MODEL_NAME    nome do modelo (aparece no cabeçalho do .md, como no transcrever.py)

Eventos extras por arquivo (o BDS usa para mostrar o andamento de cada um):
    [file] <n> start | progress <pct> | done | error <mensagem>      (n começa em 1)
"""
import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

SAMPLE_RATE = 16000
LOG_PATH = os.environ.get("WL_LOG")


def log(line: str) -> None:
    """Grava uma linha no log do contrato (e no stdout, para depuração manual)."""
    print(line, flush=True)
    if LOG_PATH:
        with open(LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")


class EngineError(Exception):
    pass


def register_cuda(project: Path) -> None:
    """Deixa as DLLs do CUDA (pip nvidia-*, ou WL_CUDA_DIR) carregáveis."""
    dirs = []
    extra = os.environ.get("WL_CUDA_DIR")
    if extra and os.path.isdir(extra):
        dirs.append(extra)
    nvidia = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
    if nvidia.is_dir():
        dirs.extend(str(p) for p in nvidia.glob("*/bin") if p.is_dir())
    for directory in dirs:
        if hasattr(os, "add_dll_directory"):
            os.add_dll_directory(directory)
        os.environ["PATH"] = directory + os.pathsep + os.environ.get("PATH", "")


def load_model(model_dir: str, force_cpu: bool):
    from faster_whisper import WhisperModel

    if not force_cpu:
        try:
            model = WhisperModel(model_dir, device="cuda", compute_type="int8_float16")
            return model, "GPU (CUDA)"
        except Exception as exc:  # sem placa/driver/DLLs: cai para a CPU
            log(f"[line] GPU indisponível ({str(exc)[:120]}); usando a CPU.")
    try:
        return WhisperModel(model_dir, device="cpu", compute_type="int8"), "CPU"
    except Exception as exc:
        raise EngineError(f"Não foi possível carregar o modelo: {exc}") from exc


def decode_audio(media: Path):
    """Áudio mono 16 kHz em float32, via ffmpeg."""
    import numpy as np

    ffmpeg = os.environ.get("WL_FFMPEG") or "ffmpeg"
    try:
        result = subprocess.run(
            [ffmpeg, "-nostdin", "-v", "error", "-i", str(media), "-vn", "-ac", "1",
             "-ar", str(SAMPLE_RATE), "-f", "s16le", "-"],
            capture_output=True, stdin=subprocess.DEVNULL, check=True,
        )
    except FileNotFoundError as exc:
        raise EngineError("O ffmpeg não foi encontrado.") from exc
    except subprocess.CalledProcessError as exc:
        raise EngineError(f"O ffmpeg não conseguiu ler o arquivo: {exc.stderr.decode('utf-8', 'replace').strip()}") from exc
    return np.frombuffer(result.stdout, dtype=np.int16).astype(np.float32) / 32768.0


def stamp(seconds: float) -> str:
    seconds = int(seconds)
    return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def process_file(model, model_name: str, media: Path, out_dir, want_srt: bool, want_md: bool, max_words: int,
                 lines_per_cue: int, index: int, total: int, legendar) -> None:
    target_dir = Path(out_dir) if out_dir else media.parent
    target_dir.mkdir(parents=True, exist_ok=True)

    log(f"[status] Lendo o áudio de {media.name}")
    audio = decode_audio(media)
    segments, info = model.transcribe(
        audio, language="pt", vad_filter=True, beam_size=1,
        condition_on_previous_text=False, word_timestamps=want_srt,
    )

    words, lines = [], []
    last_report = -1.0
    last_file_report = -1.0
    for segment in segments:
        text = segment.text.strip()
        if text:
            lines.append((segment.start, text))
        if want_srt:
            words.extend(segment.words or [])
        fraction = (segment.end / info.duration) if info.duration else 1.0
        overall = (index + min(fraction, 1.0)) / total * 100
        if overall - last_report >= 0.5:
            log(f"[progress] {overall:.1f}")
            last_report = overall
        file_pct = min(fraction, 1.0) * 100
        if file_pct - last_file_report >= 1.0:
            log(f"[file] {index + 1} progress {file_pct:.1f}")
            last_file_report = file_pct

    if not lines and not words:
        raise EngineError("Nenhuma fala foi detectada no arquivo.")

    if want_srt:
        cues = legendar.build_cues(words, max_words, lines_per_cue, 42)
        target = legendar.free_path(target_dir / f"{media.stem}.srt")
        legendar.write_srt(cues, target, lines_per_cue, 42)
        log(f"[line] Legenda criada: {target.name} ({len(cues)} legendas)")
    if want_md:
        target = legendar.free_path(target_dir / f"{media.stem}.md")
        with open(target, "w", encoding="utf-8") as handle:
            # mesmo formato do transcrever.py do projeto "Whisper + LM Studio"
            handle.write(
                f"# {media.stem}\n\nTranscrição automática (Whisper {model_name}). "
                f"Duração: {stamp(info.duration)}\n\n"
            )
            for start, text in lines:
                handle.write(f"**[{stamp(start)}]** {text}\n\n")
        log(f"[line] Transcrição criada: {target.name}")


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Motor de transcrição (desenvolvimento).")
    parser.add_argument("--cli", choices=("jobs",), required=True)
    parser.add_argument("--srt", action="store_true")
    parser.add_argument("--md", action="store_true")
    parser.add_argument("--cpu", action="store_true")
    parser.add_argument("--saida")
    parser.add_argument("--palavras", type=int, default=0)
    parser.add_argument("--linhas", type=int, default=2, choices=(1, 2))
    parser.add_argument("arquivos", nargs="+")
    args = parser.parse_args()

    started = time.time()
    model_dir = os.environ.get("WL_MODEL_DIR")
    model_name = os.environ.get("WL_MODEL_NAME") or Path(model_dir or "").name or "whisper"
    project = os.environ.get("WL_DEV_PROJECT")
    try:
        if not model_dir or not (Path(model_dir) / "model.bin").is_file():
            raise EngineError("WL_MODEL_DIR não aponta para um modelo (model.bin).")
        if not project or not (Path(project) / "legendar.py").is_file():
            raise EngineError("WL_DEV_PROJECT não aponta para a pasta 'Whisper + LM Studio'.")
        sys.path.insert(0, project)
        import legendar  # reaproveita a divisão de legendas do projeto

        force_cpu = args.cpu or os.environ.get("WL_FORCE_CPU") == "1"
        register_cuda(Path(project))
        log("[status] Carregando o modelo…")
        model, device = load_model(model_dir, force_cpu)
        log(f"[device] {device}")
    except EngineError as exc:
        log(f"ERRO: {exc}")
        return 1
    except Exception as exc:
        log(f"ERRO: {type(exc).__name__}: {exc}")
        return 1

    ok = failed = 0
    for index, name in enumerate(args.arquivos):
        media = Path(name)
        log(f"[file] {index + 1} start")
        try:
            process_file(model, model_name, media, args.saida, args.srt, args.md, args.palavras, args.linhas,
                         index, len(args.arquivos), legendar)
            ok += 1
            log(f"[file] {index + 1} done")
        except EngineError as exc:
            failed += 1
            log(f"[line] ERRO em {media.name}: {exc}")
            log(f"[file] {index + 1} error {exc}")
        except Exception as exc:  # um arquivo ruim não derruba os demais
            failed += 1
            log(f"[line] ERRO em {media.name}: {type(exc).__name__}: {exc}")
            log(f"[file] {index + 1} error {type(exc).__name__}: {exc}")

    log("[progress] 100.0")
    log(f"RESULTADO ok={ok} falhas={failed} [{device}] ({time.time() - started:.0f} s)")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
