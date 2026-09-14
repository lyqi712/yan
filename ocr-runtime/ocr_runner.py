import argparse
import json
import os
import sys
import tempfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    source = Path(args.input).resolve()
    if not source.is_file():
        raise FileNotFoundError('输入文件不存在')
    lines, warnings = [], []
    engine = None
    ocr_used = False
    page_count = 1
    processed_pages = 0

    def run_ocr(image, page):
        nonlocal engine, ocr_used
        if engine is None:
            model_dir = Path(os.environ.get('WXLENS_OCR_MODEL_DIR', str(Path(__file__).parent / 'models')))
            required = {name: model_dir / name for name in ['det.onnx', 'rec.onnx', 'cls.onnx', 'keys.txt']}
            if not all(p.is_file() for p in required.values()):
                raise RuntimeError('OCR模型未就绪，请按docs/optional-runtime.md手动准备det.onnx、rec.onnx、cls.onnx和keys.txt。读取时不自动下载模型。')
            from rapidocr import RapidOCR
            engine = RapidOCR(params={'Det.model_path': str(required['det.onnx']), 'Rec.model_path': str(required['rec.onnx']), 'Cls.model_path': str(required['cls.onnx']), 'Rec.rec_keys_path': str(required['keys.txt']), 'Det.limit_side_len': 1280, 'Det.limit_type': 'max'})
        result = engine(str(image))
        ocr_used = True
        texts = getattr(result, 'txts', None)
        scores = getattr(result, 'scores', None)
        for index, text in enumerate([] if texts is None else list(texts)):
            if str(text).strip():
                lines.append({'page': page, 'text': str(text).strip(), 'confidence': float(scores[index]) if scores is not None and index < len(scores) else None})

    if source.suffix.lower() == '.pdf':
        import pymupdf
        with pymupdf.open(source) as document:
            page_count = document.page_count
            maximum = min(max(int(os.environ.get('WXLENS_PDF_MAX_PAGES', '200')), 1), 500)
            with tempfile.TemporaryDirectory(prefix='yan-pdf-') as temporary:
                for index in range(min(page_count, maximum)):
                    page = document[index]
                    native = page.get_text('text').strip()
                    if native:
                        lines.extend({'page': index + 1, 'text': text, 'confidence': 1.0} for text in native.splitlines() if text.strip())
                    else:
                        image = Path(temporary) / 'page.png'
                        page.get_pixmap(matrix=pymupdf.Matrix(1.25, 1.25), alpha=False, colorspace=pymupdf.csGRAY).save(image)
                        try:
                            run_ocr(image, index + 1)
                        except RuntimeError as error:
                            warnings.append(f'第{index + 1}页未读取：{error}')
                    processed_pages += 1
            if page_count > maximum:
                warnings.append(f'PDF共{page_count}页，本次只处理前{maximum}页。')
    else:
        run_ocr(source, 1)
        processed_pages = 1
    scores = [line['confidence'] for line in lines if line['confidence'] is not None]
    result = {'text': '\n'.join(line['text'] for line in lines), 'parser': 'rapidocr-local-models' if ocr_used else 'pymupdf-native-text', 'ocrUsed': ocr_used, 'confidence': sum(scores) / len(scores) if scores else None, 'pages': page_count, 'processedPages': processed_pages, 'lines': len(lines), 'warnings': warnings, 'metadata': {'lineDetails': lines, 'automaticModelDownload': False, 'partial': bool(warnings)}}
    sys.stdout.write(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        sys.stderr.write(f'{type(error).__name__}: {error}\n')
        sys.exit(1)
