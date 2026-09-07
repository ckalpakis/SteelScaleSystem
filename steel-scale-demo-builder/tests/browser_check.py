from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from threading import Thread
from playwright.sync_api import sync_playwright
root = Path(__file__).resolve().parents[1]
server = ThreadingHTTPServer(('127.0.0.1', 0), partial(SimpleHTTPRequestHandler, directory=str(root)))
thread = Thread(target=server.serve_forever, daemon=True); thread.start()
results = []
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
        page = browser.new_page(viewport={'width':1280,'height':960})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(f'http://127.0.0.1:{server.server_port}/PREVIEW.html')
        page.get_by_role('button', name='Run sample').first.click()
        assert 'Thanks for contacting' in page.locator('[data-module="voice"] .messages').inner_text()
        results.append('PASS: Receptionist sample executes in browser.')
        page.locator('[data-module="voice"] [data-reset]').click()
        assert 'Press' in page.locator('[data-module="voice"] .messages').inner_text()
        results.append('PASS: Reset clears simulation state.')
        page.locator('#calculate').click()
        assert '$2,500' in page.locator('#roi-result').inner_text()
        assert '$500/month' in page.locator('#roi-result').inner_text()
        results.append('PASS: Browser ROI example produces $2,500 revenue and $500 contribution after fee.')
        page.locator('[data-roi="1"]').fill('120'); page.locator('#calculate').click()
        assert 'valid nonnegative' in page.locator('#roi-result').inner_text()
        results.append('PASS: Browser rejects percentage above 100%.')
        page.locator('[data-roi="1"]').fill('50'); page.locator('[data-roi="0"]').fill(''); page.locator('#calculate').click()
        assert 'valid nonnegative' in page.locator('#roi-result').inner_text()
        results.append('PASS: Browser rejects blank ROI input.')
        page.locator('[data-roi="0"]').fill('20'); page.locator('#calculate').click()
        assert page.locator('#demo').get_attribute('data-events') == ''
        results.append('PASS: Private preview has no analytics endpoint.')
        assert not errors, errors
        results.append('PASS: No uncaught browser JavaScript errors.')
        page.screenshot(path=str(root/'tests/desktop-preview.png'), full_page=True)
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        results.append('PASS: Mobile layout has no horizontal overflow at 390px width.')
        page.screenshot(path=str(root/'tests/mobile-preview.png'), full_page=True)
        browser.close()
    (root/'tests/browser-results.txt').write_text('\n'.join(results)+'\n')
    print('\n'.join(results))
finally:
    server.shutdown(); server.server_close()
