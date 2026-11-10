"""Offline model only. No cloud adapter, authentication or deployment handler."""
import hashlib
import io
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from threading import RLock
from urllib.parse import quote
from pypdf import PdfReader

MAX_BYTES = 10 * 1024 * 1024

class Rejected(Exception):
    pass

class Conflict(Exception):
    pass

@dataclass
class Operation:
    source: str
    size: int
    digest: str
    expires: datetime
    public_key: str
    status: str = 'pending'

class Publisher:
    """In-memory lock/registry is for tests only; it is NOT distributed state."""
    def __init__(self, storage, viewer_url):
        self.storage, self.viewer_url = storage, viewer_url
        self.operations = {}
        self.lock = RLock()

    def register(self, operation_id, source, size, digest, expires):
        if not re.fullmatch(r'[0-9a-f]{64}', operation_id): raise Rejected('operation id')
        if not re.fullmatch(r'staging/[0-9a-f]{64}\.pdf', source): raise Rejected('source')
        if type(size) is not int or not 1 <= size <= MAX_BYTES: raise Rejected('size')
        if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest): raise Rejected('digest')
        if not isinstance(expires, datetime) or expires.tzinfo is None: raise Rejected('expiry')
        with self.lock:
            old = self.operations.get(operation_id)
            if old:
                if (old.source,old.size,old.digest,old.expires) != (source,size,digest,expires): raise Conflict('different request')
                return
            self.operations[operation_id] = Operation(source,size,digest,expires,'estimates/'+secrets.token_hex(32)+'.pdf')

    def publish(self, operation_id):
        with self.lock:
            op = self.operations[operation_id]
            if op.status == 'revoked': raise Rejected('revoked')
            # Even on retry, validate the already-created output before returning a URL.
            existing = self.storage.get_optional('public', op.public_key)
            if existing is not None:
                self._verify(existing, op)
                op.status = 'published'
                return self._url(op)
            if op.status == 'published': raise Rejected('published object missing')
            size, etag = self.storage.head('staging', op.source)
            if size != op.size or size > MAX_BYTES: raise Rejected('size')
            data = self.storage.get_if_match('staging', op.source, etag, MAX_BYTES)
            self._verify(data, op)
            # Publishes precisely the validated bytes, conditional destination creation.
            try:
                self.storage.put_if_absent('public', op.public_key, data, 'application/pdf')
            except Conflict:
                pass
            self._verify(self.storage.get('public', op.public_key, MAX_BYTES), op)
            op.status = 'published'
            return self._url(op)

    @staticmethod
    def _verify(data, op):
        if len(data) != op.size or len(data) > MAX_BYTES: raise Rejected('size')
        if hashlib.sha256(data).hexdigest() != op.digest: raise Rejected('sha256')
        if not data.startswith(b'%PDF-'): raise Rejected('pdf')
        try:
            pdf = PdfReader(io.BytesIO(data), strict=True)
            if pdf.is_encrypted or not 1 <= len(pdf.pages) <= 200: raise Rejected('pdf')
            for page in pdf.pages: _ = page.mediabox
        except Rejected: raise
        except Exception as exc: raise Rejected('pdf') from exc

    def _url(self, op):
        return self.viewer_url + quote(op.public_key, safe='/')

    def revoke(self, operation_id):
        with self.lock:
            op = self.operations[operation_id]
            # Tombstone first, so failures leave operation non-republishable.
            op.status = 'revoked'
            self.storage.delete('public', op.public_key)

    def cleanup(self, operation_id, now=None):
        with self.lock:
            op = self.operations[operation_id]
            now = now or datetime.now(timezone.utc)
            if now <= op.expires: raise Rejected('upload authorization still active')
            self.storage.delete('staging', op.source)
