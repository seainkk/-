"""Registry-wide Promouser settings, with local RPC fakes only."""

import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).with_name('performance-fixture.js').read_text(encoding='utf-8')
HTML = (ROOT / 'src/Index.html').read_text(encoding='utf-8').replace(
    "<?!= include_('Styles'); ?>", (ROOT / 'src/Styles.html').read_text(encoding='utf-8')
).replace(
    "<?!= include_('Client'); ?>",
    '<script>' + FIXTURE + '</script>' + (ROOT / 'src/Client.html').read_text(encoding='utf-8')
)


def main():
    with sync_playwright() as playwright:
        if sys.platform == 'win32':
            browser = playwright.chromium.launch(channel='chrome', headless=True)
        else:
            browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 360, 'height': 780})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content(HTML)
        page.wait_for_function('backend.active === 0 && backend.sourceGets > 0')
        assert page.evaluate("""
            !backend.calls.some(call => call.name === 'getPromouserSettings')
        """), 'Do not request provider configuration until the user opens it'

        opener = page.locator('#br-provider-open')
        dialog = page.locator('#br-provider-dialog')
        key = page.locator('#br-provider-key')
        limit = page.locator('#br-provider-limit')
        enabled = page.locator('#br-provider-enabled')
        save = page.locator('#br-provider-save')
        balance = page.locator('#br-provider-balance')
        message = page.locator('#br-provider-message')

        page.locator('#br-settings-open').click()
        opener.click()
        expect(dialog).to_be_visible()
        expect(enabled).to_be_checked()
        expect(limit).to_have_value('5')
        expect(key).to_have_value('')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')

        page.evaluate("backend.providerBalanceError='[PV_OWNER_AUTH_REQUIRED] Требуется разрешение владельца'")
        balance.click()
        expect(message).to_contain_text('Требуется разрешение владельца')
        page.evaluate('backend.providerBalanceError=null')
        balance.click()
        expect(message).to_contain_text('12.50')

        enabled.uncheck()
        save.click()
        page.wait_for_function('backend.providerSettings.enabled === false && backend.active === 0')
        assert page.evaluate("""
            backend.providerKey === 'stored-fixture-key' &&
            !('apiKey' in backend.calls.find(call => call.name === 'configurePromouser').p)
        """), 'A blank key field must preserve the existing key'

        page.evaluate("backend.holdMethods=['configurePromouser']")
        key.fill('replacement-fixture-key')
        save.click()
        page.wait_for_function("backend.pending.some(call => call.method === 'configurePromouser')")
        expect(key).to_have_value('')
        expect(save).to_be_disabled()
        page.evaluate("backend.holdMethods=[];releaseRpc('configurePromouser')")
        expect(save).to_be_enabled()
        assert page.evaluate("backend.providerKey === 'replacement-fixture-key'")
        expect(key).to_have_value('')

        automation = page.locator('#br-provider-automation')
        automation.click()
        page.wait_for_function('backend.automationInstalled === true && backend.active === 0')
        automation.click()
        page.wait_for_function('backend.automationInstalled === false && backend.active === 0')

        assert page.evaluate("""
            backend.calls.every(call => [
              'getAppBootstrap', 'getSourceBases', 'listPreparedJobs',
              'getServiceLimits', 'getPromouserSettings', 'configurePromouser', 'getPromouserBalance',
              'getContactAutomationState', 'enableContactAutomation', 'disableContactAutomation'
            ].includes(call.name) && !(call.p && ('id' in call.p || 'fileId' in call.p))) &&
            backend.transport.every(call => call.name === 'callApp' && call.keyMatches)
        """), 'Settings must use only registry RPCs without opening a workbook or placing orders'

        key.fill('unsaved-fixture-key')
        page.evaluate('backend.revoked=true')
        balance.click()
        expect(dialog).to_be_hidden()
        expect(opener).to_be_hidden()
        expect(key).to_have_value('')
        assert not errors, errors
        browser.close()
        print('PASS: registry-wide provider settings, protected key, balance and automation without a workbook')


if __name__ == '__main__':
    main()
