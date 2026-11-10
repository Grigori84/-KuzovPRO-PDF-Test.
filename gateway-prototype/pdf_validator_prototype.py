"""Offline validation prototype; never publish based on this module alone."""
import hashlib
import hmac
import re
from pathlib import Path

from pypdf import PdfReader

MAX_BYTES = 10 * 1024 * 1024
MAX_PAGES = 200


def validate(path, declared_size, expected_sha256):
    if type(declared_size) is not int or not 1 <= declared_size <= MAX_BYTES:
        raise ValueError("INVALID_SIZE")
    if not isinstance(expected_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ValueError("INVALID_SHA256")
    path = Path(path)
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while chunk := handle.read(64 * 1024):
            size += len(chunk)
            if size > MAX_BYTES or size > declared_size:
                raise ValueError("SIZE_MISMATCH")
            digest.update(chunk)
        if size != declared_size or not hmac.compare_digest(digest.hexdigest(), expected_sha256):
            raise ValueError("SIZE_OR_SHA_MISMATCH")
        handle.seek(0)
        if handle.read(5) != b"%PDF-":
            raise ValueError("NOT_PDF")
        handle.seek(0)
        try:
            pdf = PdfReader(handle, strict=True)
            if pdf.is_encrypted:
                raise ValueError("ENCRYPTED_PDF")
            count = len(pdf.pages)
            if not 1 <= count <= MAX_PAGES:
                raise ValueError("PAGE_LIMIT")
            for page in pdf.pages:
                _ = page.mediabox
        except ValueError:
            raise
        except Exception as exc:
            raise ValueError("INVALID_PDF") from exc
    return {"size": size, "sha256": digest.hexdigest(), "pages": count}
