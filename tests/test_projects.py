import copy
import io
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile

import pymupdf as fitz
from foluma.model import new_id
from foluma.service import Engine, EngineError
from foluma.storage import open_project
from PIL import Image


class FolderProjectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.sources = self.root / 'sources'
        self.sources.mkdir()
        for name, color in [('Vol.1', 'red'), ('Vol.2', 'blue'), ('Vol.10', 'green')]:
            image = io.BytesIO()
            Image.new('RGB', (40, 60), color).save(image, 'JPEG')
            with fitz.open() as doc:
                page = doc.new_page(width=40, height=60)
                xref = page.insert_image(page.rect, stream=image.getvalue())
                doc.xref_set_key(xref, "ColorSpace", "/DeviceRGB")
                doc.save(self.sources / f'{name}.pdf')
        self.engine = Engine(self.root / 'data')
        self.addCleanup(self.engine.close)

    def call(self, method, **params):
        return self.engine.call(method, params)

    def task(self, operation, **params):
        job = self.call('task.start', operation=operation, **params)
        deadline = time.monotonic() + 15
        while job['state'] == 'running' and time.monotonic() < deadline:
            time.sleep(.01)
            job = self.call('task.get', id=job['id'])
        self.assertEqual(job['state'], 'completed', job)
        return job['result']

    def create(self):
        state = self.call('series.create', parent=str(self.root), name='漫畫專案')
        self.project = Path(state['directory'])
        return self.call('series.add', paths=[str(self.sources)])

    def test_import_refresh_summaries_and_atomic_create_with_move(self):
        nested = self.sources / 'nested'
        nested.mkdir()
        shutil.copyfile(self.sources / 'Vol.1.pdf',nested / 'nested.pdf')
        state = self.create()
        self.assertEqual(state['summary'], {'added': 3, 'skipped': 0, 'folders_skipped': 1})
        repeated = self.call('series.add',paths=[str(self.sources)])
        self.assertEqual(repeated['summary'], {'added': 0, 'skipped': 3, 'folders_skipped': 1})
        one,two,ten = state['items']
        with patch.object(self.engine.series,'save',side_effect=OSError('disk full')):
            with self.assertRaisesRegex(OSError,'disk full'):
                self.call('series.group',name='Rollback',ids=[one['id'],two['id']])
        self.assertFalse((self.project / 'Rollback').exists())
        self.assertTrue(Path(one['path']).is_file())
        self.assertTrue(Path(two['path']).is_file())
        moved = self.call('series.group',name='Selected',ids=[one['id'],two['id']])
        self.assertEqual([i['group'] for i in moved['items']], ['Selected','Selected',''])
        (self.project / 'Selected/Vol.1.pdf').rename(self.project / 'Selected/Renamed.pdf')
        Path(ten['path']).rename(self.root / 'missing-source.pdf')
        refreshed = self.call('series.refresh')
        self.assertEqual(refreshed['summary'], {'added': 0, 'renamed': 1, 'missing': 1, 'changed': 0})
        self.assertTrue(refreshed['refreshed_at'])
        self.assertEqual(next(i for i in refreshed['items'] if i['id'] == one['id'])['path'],str(self.project / 'Selected/Renamed.pdf'))

    def test_page_attention_counts_require_explicit_review_override(self):
        state = self.create()
        item = state['items'][0]
        book = self.task('series.open',entry_id=item['id'])
        book = self.call('document.apply',document_id=book['id'],base_revision=book['revision'],changes={
            'extension': {'id':'org.foluma.editor','data':{'review':[book['pages'][0]['id'],book['pages'][0]['id'],'gone',{}]}}})
        self.assertEqual(self.call('series.get')['items'][0]['review_count'],1)
        with self.assertRaises(EngineError) as error:
            self.call('series.review',id=item['id'],reviewed=True)
        self.assertEqual(error.exception.data,{'kind':'pending_review','pages':1})
        with self.assertRaises(EngineError):
            self.call('series.review',id=item['id'],reviewed=True,allow_pending='true')
        reviewed = self.call('series.review',id=item['id'],reviewed=True,allow_pending=True)
        self.assertTrue(reviewed['items'][0]['reviewed'])
        self.engine.series.state['items'][0].pop('review_count')
        self.assertEqual(self.call('series.get')['items'][0]['review_count'],1,'older project manifests must recover page marks')
        self.call('document.apply',document_id=book['id'],base_revision=book['revision'],changes={
            'extension': {'id':'org.foluma.editor','data':{'review':[]}}})
        result = self.call('series.get')['items'][0]
        self.assertEqual(result['review_count'],0)
        self.assertFalse(result['reviewed'],'editing invalidates the earlier review')

    def test_folder_lifecycle_portability_and_external_changes(self):
        originals = {p.name: p.read_bytes() for p in self.sources.iterdir()}
        state = self.create()
        self.assertEqual([i['title'] for i in state['items']], ['Vol.1', 'Vol.2', 'Vol.10'])
        one, two, ten = [i['id'] for i in state['items']]
        self.call('series.add', paths=[str(self.sources)])
        self.assertEqual(len(self.call('series.get')['items']), 3)
        book = self.task('series.open', entry_id=one)
        book = self.call('document.apply', document_id=book['id'], base_revision=book['revision'], changes={
            'pages': [*book['pages'], {'id': new_id(), 'kind': 'blank', 'width': 40, 'height': 60}],
            'extension': {'id': 'test', 'data': {'mark': book['pages'][0]['id']}}})
        image = self.root / 'inserted.png'
        Image.new('RGB', (40, 60), 'pink').save(image)
        book = self.task('images.import', document_id=book['id'], base_revision=book['revision'], paths=[str(image)])
        self.assertTrue(all(Path(a['path']).is_relative_to(self.project) for a in book['assets'].values() if a['kind'] == 'file'))
        saved = copy.deepcopy(book)
        self.call('series.review', id=one, reviewed=True)
        self.call('series.group', name='本篇')
        self.call('series.move', ids=[one,two], group='本篇')
        self.assertFalse((self.project / 'Vol.1.pdf').exists())
        self.assertTrue((self.project / '本篇/Vol.1.pdf').exists())
        self.call('series.group', name='正篇', previous='本篇')
        book = self.call('document.get')
        self.assertEqual(book['revision'], saved['revision'])
        self.assertTrue(book['can_undo'])
        self.assertTrue(all('/正篇/' in s['path'] for s in book['sources'].values()))
        self.call('document.preview', document_id=book['id'], page_id=book['pages'][0]['id'], size=64)
        self.call('series.reorder', ids=[ten,one,two])
        self.call('series.remove', ids=[one])
        self.assertIsNone(self.call('document.get'))
        state = self.call('series.get')
        self.assertEqual([i['id'] for i in state['items']], [ten,two])
        self.assertEqual(state['removed'][0]['id'],one)
        self.assertTrue(Path(state['removed'][0]['path']).is_file())
        self.call('series.refresh')
        self.assertEqual(len(self.call('series.get')['items']),2)
        with self.assertRaises(ValueError):
            self.task('series.open', entry_id=one)
        moved = self.root / '搬移後的專案'
        shutil.move(self.project, moved)
        self.project = moved
        self.call('project.open', path=str(moved))
        self.call('series.restore', ids=[one])
        book = self.task('series.open', entry_id=one)
        self.assertEqual(book['pages'],saved['pages'])
        self.assertEqual(book['extensions'],saved['extensions'])
        self.assertTrue(next(i for i in self.call('series.get')['items'] if i['id']==one)['reviewed'])
        self.assertTrue(all(Path(s['path']).is_relative_to(moved) for s in book['sources'].values()))
        self.assertTrue(all(Path(a['path']).is_file() for a in book['assets'].values() if a['kind']=='file'))
        (moved/'正篇/Vol.1.pdf').rename(moved/'正篇/第一冊.pdf')
        (moved/'正篇').rename(moved/'Main')
        state = self.call('series.refresh')
        entry = next(i for i in state['items'] if i['id']==one)
        self.assertEqual(entry['group'],'Main')
        self.assertTrue(entry['path'].endswith('第一冊.pdf'))
        self.assertEqual(self.call('document.get')['revision'],saved['revision'])
        output = self.root/'output'
        output.mkdir()
        exported = self.task('export', document_id=book['id'], base_revision=book['revision'], directory=str(output))
        with ZipFile(exported['path']) as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(len([n for n in archive.namelist() if n.startswith('EPUB/pages/')]),3)
        source = Path(entry['path'])
        source.write_bytes(originals['Vol.2.pdf'])
        state = self.call('series.refresh')
        self.assertTrue(next(i for i in state['items'] if i['id']==one)['changed'])
        with self.assertRaisesRegex(ValueError,'Source changed'):
            self.call('task.start',operation='series.open',entry_id=one)
        source.unlink()
        self.call('series.refresh')
        with self.assertRaisesRegex(ValueError,'differs'):
            self.call('series.relink',id=one,path=str(self.sources/'Vol.2.pdf'))
        self.call('series.relink',id=one,path=str(self.sources/'Vol.1.pdf'))
        self.call('series.delete_group',name='Main')
        self.assertTrue((moved/'第一冊.pdf').is_file())
        self.assertFalse((moved/'Main').exists())
        self.engine.close()
        restarted = Engine(self.root/'data')
        self.addCleanup(restarted.close)
        self.assertEqual(restarted.call('document.get',{})['pages'],saved['pages'])
        self.assertEqual({p.name:p.read_bytes() for p in self.sources.iterdir()},originals)

    def test_collisions_failed_writes_and_unsafe_paths_preserve_files(self):
        state = self.create()
        one,two,_ = [i['id'] for i in state['items']]
        self.call('series.group',name='番外')
        original = self.call('series.get')
        with patch.object(self.engine.series,'save',side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                self.call('series.move',ids=[one,two],group='番外')
            with self.assertRaises(OSError):
                self.call('series.remove',ids=[one])
            with self.assertRaises(OSError):
                self.call('series.group',name='改名',previous='番外')
        self.assertEqual(self.call('series.get'),original)
        self.assertTrue((self.project/'Vol.1.pdf').is_file())
        self.assertFalse((self.project/'番外/Vol.1.pdf').exists())
        self.assertFalse((self.project/'改名').exists())
        self.call('series.move',ids=[one],group='番外')
        with patch.object(self.engine.series,'save',side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                self.call('series.delete_group',name='番外')
        self.assertTrue((self.project/'番外/Vol.1.pdf').is_file())
        self.call('series.move',ids=[one],group='')
        (self.project/'番外/Vol.1.pdf').write_text('existing file')
        with self.assertRaisesRegex(ValueError,'exists'):
            self.call('series.move',ids=[one],group='番外')
        self.assertEqual((self.project/'番外/Vol.1.pdf').read_text(),'existing file')
        for name in ('../outside','.foluma','a/b','a\\b','', ' bad'):
            with self.assertRaises(ValueError):
                self.call('series.group',name=name)
        (self.project/'linked').symlink_to(self.sources,target_is_directory=True)
        self.call('series.refresh')
        self.assertNotIn('linked',self.call('series.get')['groups'])
        with self.assertRaises(ValueError):
            self.call('series.move',ids=[one],group='linked')
        with self.assertRaises(ValueError):
            self.call('series.reorder',ids=[one,one,two])
        # Simulate a stop after the physical removal but before its manifest was committed.
        recovery = self.project/'.foluma/removed'/one/'Vol.1.pdf'
        recovery.parent.mkdir(parents=True,exist_ok=True)
        (self.project/'Vol.1.pdf').rename(recovery)
        state = self.call('project.open',path=str(self.project))
        self.assertFalse(next(i for i in state['items'] if i['id']==one)['missing'])
        self.assertTrue((self.project/'Vol.1.pdf').is_file())

    def test_legacy_migration_and_importing_an_edited_book(self):
        state = self.call('series.scan',paths=[str(self.sources)])
        one = state['items'][0]['id']
        book = self.task('series.open',entry_id=one)
        book = self.call('document.apply',document_id=book['id'],base_revision=book['revision'],changes={'metadata':{'title':'Edited title','direction':'ltr'}})
        self.call('series.review',id=one,reviewed=True)
        old_path = Path(book['project_path'])
        original = (old_path/'project.json').read_bytes()
        backup_pdf = self.root/'original.pdf'
        shutil.copyfile(self.sources/'Vol.1.pdf',backup_pdf)
        (self.sources/'Vol.1.pdf').unlink()
        (self.sources/'Vol.2.pdf').unlink()  # Never-opened missing entries have no stored fingerprint.
        state = self.call('series.migrate',parent=str(self.root),name='Migrated')
        self.assertTrue(state['managed'])
        self.assertEqual(len(state['items']),3)
        restored = self.call('document.get')
        self.assertEqual(restored['id'],book['id'])
        self.assertEqual(restored['metadata'],book['metadata'])
        self.assertTrue(state['items'][0]['reviewed'])
        self.assertTrue(state['items'][0]['missing'])
        self.assertTrue(state['items'][1]['missing'])
        self.call('series.relink',id=state['items'][0]['id'],path=str(backup_pdf))
        self.call('project.open',path=state['directory'])
        self.assertEqual(self.call('document.get')['metadata'],book['metadata'])
        self.assertEqual((old_path/'project.json').read_bytes(),original)
        self.assertTrue(all(Path(i['path']).is_relative_to(state['directory']) for i in state['items']))
        self.call('series.create',parent=str(self.root),name='Single import')
        shutil.copyfile(backup_pdf,self.sources/'Vol.1.pdf')
        state = self.call('series.add',paths=[str(old_path)])
        imported = self.task('series.open',entry_id=state['items'][0]['id'])
        self.assertEqual(imported['metadata'],book['metadata'])
        self.assertEqual(imported['pages'],book['pages'])
        disk = open_project(Path(imported['project_path']))
        self.assertTrue(all(Path(s['path']).is_file() for s in disk['sources'].values()))
        with self.assertRaisesRegex(ValueError,'already'):
            self.call('series.add',paths=[str(old_path)])


if __name__ == '__main__':
    unittest.main()
