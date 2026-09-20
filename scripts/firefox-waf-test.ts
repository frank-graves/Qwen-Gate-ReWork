// scripts/firefox-waf-test.ts
import { firefox, BrowserContext, Page } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';
import { firefox, Browser, BrowserContext, Page } from 'playwright';
import { projectPath } from '../src/utils/paths.ts';

const require = createRequire(import.meta.url);
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0';

type WafCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

type ConfigResult = {
  name: 'vanilla' | 'hardened';
  wafPassed: boolean;
  checks: WafCheck[];
  cookiesFound: string[];
  apiStatus: number | null;
  apiContentType: string | null;
  apiPreview: string | null;
  errors: string[];
};

type ExperimentReport = {
  timestamp: string;
  userAgent: string;
  playwrightVersion: string;
  firefoxBinaryPath: string | null;
  configs: ConfigResult[];
  conclusion: 'firefox-supported' | 'firefox-partial' | 'firefox-unsupported';
  conclusionReason: string;
};

function parseHardenedPrefs(): Record<string, string | number | boolean> {
  const prefsPath = join(import.meta.dir, 'profiles', 'firefox-hardened-user.js');
  let raw = '';
  try {
    raw = readFileSync(prefsPath, 'utf-8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[waf-test] Could not read hardened prefs file: ${msg}`);
    return {};
  }

  const prefs: Record<string, string | number | boolean> = {};
  const regex = /user_pref\("([^"]+)",\s*(.+)\);/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    const key = match[1];
    let val: string | number | boolean = match[2].trim();
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (/^-?\d+$/.test(val)) val = parseInt(val, 10);
    else if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    prefs[key] = val;
  }
  return prefs;
}

async function runConfig(
  configName: 'vanilla' | 'hardened',
  hardenedPrefs: Record<string, string | number | boolean>
): Promise<ConfigResult> {
  const result: ConfigResult = {
    name: configName,
    wafPassed: false,
    checks: [],
    cookiesFound: [],
    apiStatus: null,
    apiContentType: null,
    apiPreview: null,
    errors: [],
  };

  const userAgent = 'Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0';
  
  let browser: Browser | undefined;
  try {
    browser = await firefox.launch({
      headless: true,
      firefoxUserPrefs: configName === 'hardened' ? hardenedPrefs : undefined,
    });
  } catch (launchErr: unknown) {
    const msg = launchErr instanceof Error ? launchErr.message : String(launchErr);
    result.errors.push(`Browser launch failed: ${msg}`);
    return result;
  }

  let context: BrowserContext | undefined;
  let page: Page | undefined;

  try {
    context = await browser.newContext({
      userAgent,
      viewport: { width: 1280, height: 800 },
    });
    page = await context.newPage();

    const wafConsoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text().toLowerCase();
        if (text.includes('aliyun') || text.includes('waf') || text.includes('baxia') || text.includes('captcha')) {
          wafConsoleErrors.push(msg.text());
        }
      }
    });

    // Check 1: Page loads without WAF challenge
    try {
      await page.goto('https://chat.qwen.ai', { waitUntil: 'domcontentloaded', timeout: 30000 });
      
      // The WAF scripts need a moment to inject their challenge DOM if they decide to block us.
      await page.waitForTimeout(5000); 
      
      const pageMarkup = await page.evaluate(() => document.documentElement.innerHTML);
      const hasAliyunWaf = pageMarkup.includes('aliyun_waf');
      const has405Title = pageMarkup.includes('<title>405</title>');
      
      const titleMatch = pageMarkup.match(/<title>(.*?)<\/title>/i);
      const documentTitle = titleMatch ? titleMatch[1] : '';
      const hasQwenInTitle = documentTitle.toLowerCase().includes('qwen');
      
      const hasRootWithChildren = await page.evaluate(() => {
        const root = document.getElementById('root');
        return root ? root.children.length > 0 : false;
      });
      
      const hasQwenScript = pageMarkup.includes('chat.qwen.ai');
      const passed = !hasAliyunWaf && !has405Title && (hasQwenInTitle || hasRootWithChildren || hasQwenScript);
      
      result.checks.push({
        name: 'page-load',
        passed,
        detail: passed 
          ? 'Page loaded and Qwen UI markers detected.' 
          : `Title: "${documentTitle.slice(0, 100)}", aliyun_waf: ${hasAliyunWaf}`
      });
    } catch (check1Err: unknown) {
      const msg = check1Err instanceof Error ? check1Err.message : String(check1Err);
      result.errors.push(`Check 1 error: ${msg}`);
      result.checks.push({ name: 'page-load', passed: false, detail: `Navigation failed: ${msg}` });
    }

    // Check 2: Cookies
    try {
      if (context) {
        const cookieJar = await context.cookies();
        const expected = ['cna', 'ssxmod_itna', 'tfstk', 'isg', 'acw_tc', 'token'];
        const harvestedCookies = cookieJar
          .filter(c => c.domain.includes('qwen.ai') || c.domain.includes('alibaba'))
          .map(c => c.name);
        
        result.cookiesFound = harvestedCookies;
        const matchedExpected = expected.filter(e => harvestedCookies.includes(e));
        const missingExpected = expected.filter(e => !harvestedCookies.includes(e));
        
        const passed = matchedExpected.length >= 3;
        result.checks.push({
          name: 'cookies',
          passed,
          detail: passed 
            ? `Found ${matchedExpected.length}/6 expected cookies.` 
            : `Found: [${matchedExpected.join(', ')}], Missing: [${missingExpected.join(', ')}]`
        });
      }
    } catch (check2Err: unknown) {
      const msg = check2Err instanceof Error ? check2Err.message : String(check2Err);
      result.errors.push(`Check 2 error: ${msg}`);
      result.checks.push({ name: 'cookies', passed: false, detail: `Cookie extraction failed: ${msg}` });
    }

    // Check 3: API call
    try {
      if (page) {
        const apiTimeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 15000));
        
        // The WAF occasionally intercepts API calls and serves a captcha challenge
        // with a 200 OK status. We race the fetch against a timeout and inspect
        // the raw preview to catch these silent failures.
        const apiProbe = page.evaluate(async () => {
          try {
            const resp = await fetch('/api/models', {
              method: 'GET',
              credentials: 'include',
              headers: { accept: 'application/json, text/plain, */*' },
            });
            const text = await resp.text();
            return {
              status: resp.status,
              contentType: resp.headers.get('content-type') || '',
              preview: text.slice(0, 200),
            };
          } catch (e: unknown) {
            const errMsg = e instanceof Error ? e.message : String(e);
            return { status: 0, contentType: '', preview: `fetch error: ${errMsg}` };
          }
        });
        
        const apiProbeResult = await Promise.race([apiProbe, apiTimeout]);
        
        if (apiProbeResult === null) {
          result.checks.push({ name: 'api-call', passed: false, detail: 'API call timed out after 15s.' });
        } else {
          result.apiStatus = apiProbeResult.status;
          result.apiContentType = apiProbeResult.contentType;
          result.apiPreview = apiProbeResult.preview;
          
          const isJson = apiProbeResult.contentType.includes('application/json');
          const isHtml = apiProbeResult.preview.trim().startsWith('<');
          const passed = apiProbeResult.status === 200 && isJson && !isHtml;
          
          result.checks.push({
            name: 'api-call',
            passed,
            detail: passed
              ? `Status ${apiProbeResult.status}, valid JSON response.`
              : `Status ${apiProbeResult.status}, content-type: ${apiProbeResult.contentType}${isHtml ? ' (WAF served HTML challenge)' : ''}`
          });
        }
      }
    } catch (check3Err: unknown) {
      const msg = check3Err instanceof Error ? check3Err.message : String(check3Err);
      result.errors.push(`Check 3 error: ${msg}`);
      result.checks.push({ name: 'api-call', passed: false, detail: `Evaluation failed: ${msg}` });
    }

    // Check 4: Console errors
    try {
      // Baxia scripts are notorious for logging silent failures to the console
      // without throwing JS exceptions. We listen for specific WAF keywords.
      const truncatedErrors = wafConsoleErrors.slice(0, 3).map(e => e.slice(0, 120));
      const passed = truncatedErrors.length === 0;
      result.checks.push({
        name: 'console-errors',
        passed,
        detail: passed
          ? 'No WAF-related console errors detected.'
          : `Found ${wafConsoleErrors.length} WAF errors. First 3: ${truncatedErrors.join(' | ')}`
      });
    } catch (check4Err: unknown) {
      const msg = check4Err instanceof Error ? check4Err.message : String(check4Err);
      result.errors.push(`Check 4 error: ${msg}`);
      result.checks.push({ name: 'console-errors', passed: false, detail: `Check failed: ${msg}` });
    }

    result.wafPassed = result.checks.length === 4 && result.checks.every(c => c.passed);

  } catch (ctxErr: unknown) {
    const msg = ctxErr instanceof Error ? ctxErr.message : String(ctxErr);
    result.errors.push(`Context execution error: ${msg}`);
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  return result;
}

async function main() {
  const hardenedPrefs = parseHardenedPrefs();
  
  let playwrightVersion = 'unknown';
  try {
    const pkgRaw = readFileSync(require.resolve('playwright/package.json'), 'utf-8');
    playwrightVersion = JSON.parse(pkgRaw).version as string;
  } catch {
    // silent fallback
  }

  const firefoxBinaryPath = firefox.executablePath();
  const userAgent = 'Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0';

  const configs: ConfigResult[] = [];
  
  console.log('[waf-test] Running vanilla Firefox config...');
  configs.push(await runConfig('vanilla', hardenedPrefs));
  
  console.log('[waf-test] Running hardened Firefox config...');
  configs.push(await runConfig('hardened', hardenedPrefs));

  const passedConfigs = configs.filter(c => c.wafPassed);
  let conclusion: ExperimentReport['conclusion'] = 'firefox-unsupported';
  let conclusionReason = 'Both vanilla and hardened configs failed WAF checks.';

  if (passedConfigs.length === 2) {
    conclusion = 'firefox-supported';
    conclusionReason = 'Both vanilla and hardened profiles successfully bypassed the WAF.';
  } else if (passedConfigs.length === 1) {
    conclusion = 'firefox-partial';
    conclusionReason = `Only the '${passedConfigs[0].name}' profile passed the WAF checks.`;
  }

  const report: ExperimentReport = {
    timestamp: new Date().toISOString(),
    userAgent,
    playwrightVersion,
    firefoxBinaryPath,
    configs,
    conclusion,
    conclusionReason,
  };

  const reportJson = JSON.stringify(report, null, 2);
  console.log(reportJson);

  try {
    mkdirSync(projectPath('logs'), { recursive: true });
    writeFileSync(projectPath('logs', 'firefox-waf-test.json'), reportJson);
  } catch (writeErr: unknown) {
    const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
    console.error(`[waf-test] Failed to write report to logs/: ${msg}`);
  }

  process.exit(passedConfigs.length > 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[waf-test] Fatal error: ${msg}`);
  process.exit(1);
});