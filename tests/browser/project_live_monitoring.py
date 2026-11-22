"""Visible project polling, transport scope and selection guards with synthetic data."""
import sys
from playwright.sync_api import expect, sync_playwright
from project_client import integrated_html


def main():
    with sync_playwright() as playwright:
        chrome = {'channel': 'chrome'} if sys.platform == 'win32' else {'executable_path': '/usr/bin/chromium'}
        browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'], **chrome)
        page = browser.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content(integrated_html())
        page.wait_for_function('backend.sourceGets > 0 && backend.active === 0')
        page.evaluate("testClock.now=Date.parse('2026-11-22T12:00:00Z')")

        def idle():
            page.wait_for_function('backend.active === 0 && !RegistryProject.isLoading()')

        def count(method):
            return page.evaluate('method=>backend.calls.filter(call=>call.name===method).length', method)

        def tick(ms=60000):
            page.evaluate('ms=>tick(ms)', ms)
            idle()

        page.locator('#br-view-analytics').click()
        idle()
        tick()
        assert count('refreshColdyMailings') == 0
        page.locator('#pj-segment').select_option('segment-a')
        idle()
        assert count('refreshColdyMailings') == 1
        expect(page.locator('#pj-analytics-updated')).to_contain_text('раз в минуту')
        tick(1000)
        assert count('refreshColdyMailings') == 1

        page.evaluate("backend.holdMethods=['refreshColdyMailings'];tick(60000)")
        page.wait_for_function("backend.pending.some(job=>job.method==='refreshColdyMailings')")
        page.evaluate("tick(60000);window.dispatchEvent(new Event('focus'))")
        assert count('refreshColdyMailings') == 2
        page.evaluate("backend.holdMethods=[];releaseRpc('refreshColdyMailings')")
        idle()
        page.evaluate("testClock.hidden=true;document.dispatchEvent(new Event('visibilitychange'))")
        tick(120000)
        assert count('refreshColdyMailings') == 2
        page.evaluate("testClock.hidden=false;document.dispatchEvent(new Event('visibilitychange'))")
        idle()
        assert count('refreshColdyMailings') == 3
        page.locator('#pj-analytics-connect').click()
        expect(page.locator('#br-coldy-dialog')).to_be_visible()
        tick(120000)
        assert count('refreshColdyMailings') == 3
        page.locator('#br-coldy-close').click()

        page.locator('#br-view-infrastructure').click()
        idle()
        tick()
        assert count('refreshProjectInfrastructure') == 0
        assert count('refreshColdyMailings') == 3
        assert all(call['p']=={'segmentId':'segment-a','monitor':True}
                   for call in page.evaluate("backend.calls.filter(call=>call.name==='refreshColdyMailings')"))

        page.evaluate("backend.monitoringIds=['account-0','account-1'];backend.monitoringConfigured=true;RegistryProject.invalidate()")
        page.evaluate("RegistryProject.refresh({opening:true})")
        idle()
        initial = count('refreshProjectInfrastructure')
        assert initial > 0
        tick(120000)
        assert count('refreshProjectInfrastructure') > initial
        assert not any(call.get('p',{}).get('inventoryOnly') for call in page.evaluate(
            "backend.calls.filter(call=>call.name==='refreshProjectInfrastructure')"))
        assert not page.evaluate("backend.calls.some(call=>call.name==='getProjectInfrastructureSelection')")
        assert not errors, errors
        browser.close()
        print('Selected project monitoring, visibility, cooldown and transport checks passed.')


if __name__ == '__main__':
    main()
