"""Verify the catalog and segment lists on desktop and mobile using synthetic data."""
import sys
from playwright.sync_api import expect, sync_playwright
from project_client import integrated_html


def check_rows(rows):
    expect(rows.first).to_be_visible()
    expect(rows.last).to_be_visible()
    boxes = rows.evaluate_all('items=>items.map(item=>item.getBoundingClientRect().toJSON())')
    assert len(boxes) >= 2
    assert all(box['width']>0 and box['height']>0 for box in boxes)
    for previous, current in zip(boxes, boxes[1:]):
        assert abs(current['x'] - previous['x']) < 2
        assert current['y'] >= previous['y'] + previous['height'] - 1


def main():
    with sync_playwright() as runtime:
        launch = {'channel': 'chrome'} if sys.platform == 'win32' else {'executable_path': '/usr/bin/chromium'}
        browser = runtime.chromium.launch(**launch, headless=True, args=['--no-sandbox'])
        for width in (1440, 390):
            page = browser.new_page(viewport={'width': width, 'height': 950})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.set_content(integrated_html())
            files = page.locator('#br-sources-items [data-source-id]')
            expect(files).to_have_count(5)
            check_rows(files)
            expect(page.get_by_role('heading', name='Общий каталог')).to_be_visible()
            expect(page.get_by_text('Проверить связи компаний', exact=True)).to_have_count(0)
            expect(page.locator('[data-source-id="source-companies"] h2 button')).to_be_visible()
            expect(page.locator('[data-source-id="source-csv"] h2 a')).to_have_attribute(
                'href', 'https://drive.google.com/file/d/source-csv/view')
            details = files.first.locator('details.br-source-settings')
            details.locator('summary').first.click()
            assert details.evaluate('(el)=>el.open')
            page.locator('#br-view-segments').click()
            segments = page.locator('article[data-segment]')
            expect(segments).to_have_count(2)
            check_rows(segments)
            expect(segments.first.locator('button.br-segment-row-name')).to_be_visible()
            assert not page.evaluate("backend.calls.some(c=>c.name==='previewSourceBaseContacts')")
            assert not errors, errors
            page.close()
        browser.close()
    print('PASS: catalog and segments use one row per item on desktop and mobile.')


if __name__ == '__main__':
    main()
