import hashlib
import io
import threading
import unittest
from datetime import datetime, timezone, timedelta
from pypdf import PdfWriter
from publisher import Publisher, Rejected, Conflict, MAX_BYTES

class Storage:
    def __init__(self): self.data = {}; self.replace_on_read = None; self.fail_delete = False
    def put_if_absent(self,b,k,data,content_type):
        if (b,k) in self.data: raise Conflict()
        self.data[b,k] = bytes(data)
    def head(self,b,k):
        data=self.data[b,k]; return len(data),hashlib.md5(data).hexdigest()
    def get_if_match(self,b,k,etag,limit):
        if self.replace_on_read is not None: self.data[b,k]=self.replace_on_read
        size,current=self.head(b,k)
        if current != etag: raise Conflict('etag')
        return self.get(b,k,limit)
    def get(self,b,k,limit):
        data=self.data[b,k]
        if len(data)>limit: raise Rejected('size')
        return data
    def get_optional(self,b,k): return self.data.get((b,k))
    def delete(self,b,k):
        if self.fail_delete: raise RuntimeError('storage unavailable')
        self.data.pop((b,k),None)

def pdf():
    w=PdfWriter(); w.add_blank_page(width=100,height=100); b=io.BytesIO(); w.write(b); return b.getvalue()

class Tests(unittest.TestCase):
    def setUp(self):
        self.s=Storage(); self.p=Publisher(self.s,'https://viewer.invalid/?file='); self.id='a'*64; self.key='staging/'+'b'*64+'.pdf'; self.doc=pdf(); self.exp=datetime.now(timezone.utc)+timedelta(minutes=5); self.digest=hashlib.sha256(self.doc).hexdigest()
        self.s.data['staging',self.key]=self.doc
        self.p.register(self.id,self.key,len(self.doc),self.digest,self.exp)
    def test_publish_repeat_and_revoke(self):
        link=self.p.publish(self.id); self.assertEqual(link,self.p.publish(self.id)); self.assertEqual(len([x for x in self.s.data if x[0]=='public']),1)
        self.p.revoke(self.id); self.p.revoke(self.id)
        with self.assertRaises(Rejected): self.p.publish(self.id)
        self.assertFalse(any(x[0]=='public' for x in self.s.data))
    def test_bad_registration(self):
        for n in (0,MAX_BYTES+1,True):
            with self.assertRaises(Rejected): self.p.register('c'*64,self.key,n,self.digest,self.exp)
        with self.assertRaises(Conflict): self.p.register(self.id,self.key,1,self.digest,self.exp)
    def test_invalid_inputs(self):
        for doc in (b'not a pdf', b'%PDF-1.7\ninvalid'):
            self.s.data['staging',self.key]=doc; self.p.operations[self.id].size=len(doc); self.p.operations[self.id].digest=hashlib.sha256(doc).hexdigest()
            with self.assertRaises(Rejected): self.p.publish(self.id)
        self.s.data['staging',self.key]=self.doc; self.p.operations[self.id].size=len(self.doc); self.p.operations[self.id].digest='0'*64
        with self.assertRaises(Rejected): self.p.publish(self.id)
    def test_etag_race(self):
        self.s.replace_on_read=b'changed'
        with self.assertRaises(Conflict): self.p.publish(self.id)
        self.assertFalse(any(x[0]=='public' for x in self.s.data))
    def test_cleanup_waits_for_expiry(self):
        with self.assertRaises(Rejected): self.p.cleanup(self.id)
        self.p.cleanup(self.id,self.exp+timedelta(seconds=1)); self.assertNotIn(('staging',self.key),self.s.data)
    def test_delete_failure_keeps_tombstone(self):
        self.p.publish(self.id); self.s.fail_delete=True
        with self.assertRaises(RuntimeError): self.p.revoke(self.id)
        with self.assertRaises(Rejected): self.p.publish(self.id)
        self.s.fail_delete=False; self.p.revoke(self.id)
    def test_concurrent_repeat(self):
        results=[]; threads=[threading.Thread(target=lambda: results.append(self.p.publish(self.id))) for _ in range(2)]
        for t in threads: t.start()
        for t in threads: t.join()
        self.assertEqual(len(results),2); self.assertEqual(results[0],results[1]); self.assertEqual(sum(x[0]=='public' for x in self.s.data),1)
    def test_conflicting_existing_public(self):
        self.s.data['public',self.p.operations[self.id].public_key]=b'wrong'
        with self.assertRaises(Rejected): self.p.publish(self.id)

if __name__=='__main__': unittest.main()
