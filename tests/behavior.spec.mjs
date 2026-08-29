import { expect, test } from '@playwright/test';
import { forcePlatform } from './helpers.mjs';

const CONFIRM_ENDPOINT = '**/v1/realunit/confirm-aktionariat**';

// Fulfil the confirm endpoint with a fixed status/body so the fetch → mapResult →
// render path runs deterministically without a live API call.
async function routeConfirm(page, { status = 200, body = {} } = {}) {
  await page.route(CONFIRM_ENDPOINT, (route) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }),
  );
}

test.describe('platform detection', () => {
  test('a desktop visitor gets no data-platform attribute', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'desktop-only');
    await page.goto('/');
    expect(await page.locator('html').getAttribute('data-platform')).toBeNull();
  });

  test('the iPhone device is detected as iOS', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-safari', 'phone-only');
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-platform', 'ios');
  });

  for (const platform of ['ios', 'android']) {
    test(`a forced ${platform} user-agent sets html[data-platform="${platform}"]`, async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-chromium', 'runs once on desktop');
      await forcePlatform(page, platform);
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('data-platform', platform);
    });
  }

  test('the landing page links to the App Store, Play Store and the APK release', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'content check, once');
    await page.goto('/');
    await expect(page.locator('a[data-store="apple"]')).toHaveAttribute(
      'href',
      /apps\.apple\.com\/.*id6759720010/,
    );
    await expect(page.locator('a[data-store="play"]')).toHaveAttribute(
      'href',
      /play\.google\.com\/.*id=swiss\.realunit\.app/,
    );
    await expect(page.locator('a[data-store="apk"]')).toHaveAttribute(
      'href',
      /github\.com\/RealUnitCH\/app\/releases\/latest/,
    );
  });
});

test.describe('confirm-aktionariat flow', () => {
  // The confirmation logic is device-agnostic; run it once on desktop.
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'desktop-only confirm-flow checks');
  });

  test('a link without params shows the invalid state and makes no confirm request', async ({
    page,
  }) => {
    const confirmCalls = [];
    await page.route(CONFIRM_ENDPOINT, (route) => {
      confirmCalls.push(route.request().url());
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto('/confirm-aktionariat/');
    await expect(page.locator('#state-invalid')).toBeVisible();
    await expect(page.locator('#state-loading')).toBeHidden();
    expect(confirmCalls).toEqual([]);
  });

  for (const state of ['confirmed', 'invalid', 'no-registration', 'unavailable']) {
    test(`?mock=${state} renders the ${state} state`, async ({ page }) => {
      await page.goto(`/confirm-aktionariat/?mock=${state}`);
      await expect(page.locator(`#state-${state}`)).toBeVisible();
    });
  }

  test('a valid link confirmed by the API shows the confirmed state and calls the DEV base', async ({
    page,
  }) => {
    let requestedUrl = null;
    await page.route(CONFIRM_ENDPOINT, (route) => {
      requestedUrl = route.request().url();
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'confirmed' }),
      });
    });
    await page.goto('/confirm-aktionariat/?email=a%40b.ch&code=CODE1&user=U1');
    await expect(page.locator('#state-confirmed')).toBeVisible();
    expect(requestedUrl).toContain('https://dev.api.dfx.swiss/v1/realunit/confirm-aktionariat');
    expect(requestedUrl).toContain('email=a%40b.ch');
    expect(requestedUrl).toContain('code=CODE1');
    expect(requestedUrl).toContain('user=U1');
  });

  test('the confirm GET lower-cases a mixed-case email but keeps code/user case-sensitive', async ({
    page,
  }) => {
    let requestedUrl = null;
    await page.route(CONFIRM_ENDPOINT, (route) => {
      requestedUrl = route.request().url();
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'confirmed' }),
      });
    });
    await page.goto('/confirm-aktionariat/?email=Mixed.Case%40Example.COM&code=CoDe1&user=Uu1');
    await expect(page.locator('#state-confirmed')).toBeVisible();
    expect(requestedUrl).toContain('email=mixed.case%40example.com');
    expect(requestedUrl).not.toContain('Example.COM');
    expect(requestedUrl).toContain('code=CoDe1');
    expect(requestedUrl).toContain('user=Uu1');
  });

  test('the confirm GET forwards extra mail-link params to the API but strips the web-only api knob', async ({
    page,
  }) => {
    let requestedUrl = null;
    await page.route(CONFIRM_ENDPOINT, (route) => {
      requestedUrl = route.request().url();
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'confirmed' }),
      });
    });
    // The link carries an extra param the API must audit (address) alongside the web's own control knob (api),
    // which selects the API base but must not itself be forwarded as a query param.
    await page.goto(
      '/confirm-aktionariat/?email=a%40b.ch&code=C&user=U&address=0xAbC123&api=https%3A%2F%2Fapi.example.test',
    );
    await expect(page.locator('#state-confirmed')).toBeVisible();
    // the extra mail-link param reaches the chosen API base...
    expect(requestedUrl).toContain('https://api.example.test/v1/realunit/confirm-aktionariat');
    expect(requestedUrl).toContain('address=0xAbC123');
    // ...while the web-only api knob is not forwarded as a query param.
    expect(requestedUrl).not.toContain('api=');
  });

  test('a duplicated modelled key forwards the validated first occurrence, not the last', async ({
    page,
  }) => {
    let requestedUrl = null;
    await page.route(CONFIRM_ENDPOINT, (route) => {
      requestedUrl = route.request().url();
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'confirmed' }),
      });
    });
    // A crafted link repeats email with a second value. hasRequiredParams gates on the
    // first occurrence (first@x.ch), so the forwarded confirm call must carry that same
    // first value (lowercased) and never the trailing second@y.ch — while genuine extra
    // params (address) still pass through verbatim.
    await page.goto(
      '/confirm-aktionariat/?email=first%40x.ch&code=C&user=U&address=0xAbC&email=second%40y.ch',
    );
    await expect(page.locator('#state-confirmed')).toBeVisible();
    expect(requestedUrl).toContain('email=first%40x.ch');
    expect(requestedUrl).not.toContain('second');
    expect(requestedUrl).toContain('address=0xAbC');
  });

  test('a 200 response with the invalid status shows the invalid state', async ({ page }) => {
    await routeConfirm(page, { status: 200, body: { status: 'invalid' } });
    await page.goto('/confirm-aktionariat/?email=a%40b.ch&code=C&user=U');
    await expect(page.locator('#state-invalid')).toBeVisible();
  });

  test('a 200 response with the confirmed_no_registration status shows the no-registration state', async ({
    page,
  }) => {
    await routeConfirm(page, { status: 200, body: { status: 'confirmed_no_registration' } });
    await page.goto('/confirm-aktionariat/?email=a%40b.ch&code=C&user=U');
    await expect(page.locator('#state-no-registration')).toBeVisible();
  });

  test('a non-2xx API response shows the unavailable state', async ({ page }) => {
    await routeConfirm(page, { status: 500, body: {} });
    await page.goto('/confirm-aktionariat/?email=a%40b.ch&code=C&user=U');
    await expect(page.locator('#state-unavailable')).toBeVisible();
  });

  test('a 200 response with an unrecognized status shows the unavailable state', async ({
    page,
  }) => {
    await routeConfirm(page, { status: 200, body: { status: 'weird' } });
    await page.goto('/confirm-aktionariat/?email=a%40b.ch&code=C&user=U');
    await expect(page.locator('#state-unavailable')).toBeVisible();
  });

  test('a network error shows the unavailable state', async ({ page }) => {
    await page.route(CONFIRM_ENDPOINT, (route) => route.abort());
    await page.goto('/confirm-aktionariat/?email=a%40b.ch&code=C&user=U');
    await expect(page.locator('#state-unavailable')).toBeVisible();
  });

  test('the retry button re-runs the confirmation', async ({ page }) => {
    let calls = 0;
    await page.route(CONFIRM_ENDPOINT, (route) => {
      calls += 1;
      const ok = calls > 1; // first attempt fails, the retry succeeds
      route.fulfill({
        status: ok ? 200 : 500,
        contentType: 'application/json',
        body: JSON.stringify(ok ? { status: 'confirmed' } : {}),
      });
    });
    await page.goto('/confirm-aktionariat/?email=a%40b.ch&code=C&user=U');
    await expect(page.locator('#state-unavailable')).toBeVisible();
    await page.locator('#retry').click();
    await expect(page.locator('#state-confirmed')).toBeVisible();
    expect(calls).toBe(2);
  });

  test('?lang=en renders English copy and sets <html lang="en">', async ({ page }) => {
    await page.goto('/confirm-aktionariat/?mock=invalid&lang=en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    const expected = await page.evaluate(() => window.RealUnitConfirm.I18N.en['invalid.title']);
    await expect(page.locator('#state-invalid h1')).toHaveText(expected);
  });

  test('an ?api= override sends the confirmation to that API base', async ({ page }) => {
    let requestedUrl = null;
    await page.route(CONFIRM_ENDPOINT, (route) => {
      requestedUrl = route.request().url();
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'confirmed' }),
      });
    });
    await page.goto(
      '/confirm-aktionariat/?email=a%40b.ch&code=C&user=U&api=https%3A%2F%2Fapi.example.test',
    );
    await expect(page.locator('#state-confirmed')).toBeVisible();
    expect(requestedUrl).toContain('https://api.example.test/v1/realunit/confirm-aktionariat');
  });
});

const MERGE_CONFIRM_ENDPOINT = '**/v1/auth/mail/confirm**';
const MERGE_JOB_ENDPOINT = '**/v1/job/**';

test.describe('account-merge flow', () => {
  // The merge logic is device-agnostic; run it once on desktop.
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'desktop-only merge-flow checks');
  });

  test('a link without otp shows the invalid state and makes no confirm request', async ({
    page,
  }) => {
    const confirmCalls = [];
    await page.route(MERGE_CONFIRM_ENDPOINT, (route) => {
      confirmCalls.push(route.request().url());
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto('/account-merge/');
    await expect(page.locator('#state-invalid')).toBeVisible();
    await expect(page.locator('#state-loading')).toBeHidden();
    expect(confirmCalls).toEqual([]);
  });

  for (const state of ['confirmed', 'already-completed', 'invalid', 'unavailable']) {
    test(`?mock=${state} renders the ${state} state`, async ({ page }) => {
      await page.goto(`/account-merge/?mock=${state}`);
      await expect(page.locator(`#state-${state}`)).toBeVisible();
    });
  }

  test('a valid otp confirmed by the API shows the confirmed state and calls the DEV base', async ({
    page,
  }) => {
    let requestedUrl = null;
    await page.route(MERGE_CONFIRM_ENDPOINT, (route) => {
      requestedUrl = route.request().url();
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ kycHash: 'x' }),
      });
    });
    await page.goto('/account-merge/?otp=abc');
    await expect(page.locator('#state-confirmed')).toBeVisible();
    expect(requestedUrl).toContain('https://dev.api.dfx.swiss/v1/auth/mail/confirm');
    expect(requestedUrl).toContain('code=abc');
  });

  test('a 409 response shows the already-completed state', async ({ page }) => {
    await page.route(MERGE_CONFIRM_ENDPOINT, (route) =>
      route.fulfill({ status: 409, contentType: 'application/json', body: '{}' }),
    );
    await page.goto('/account-merge/?otp=abc');
    await expect(page.locator('#state-already-completed')).toBeVisible();
  });

  test('a 400 response shows the invalid state', async ({ page }) => {
    await page.route(MERGE_CONFIRM_ENDPOINT, (route) =>
      route.fulfill({ status: 400, contentType: 'application/json', body: '{}' }),
    );
    await page.goto('/account-merge/?otp=abc');
    await expect(page.locator('#state-invalid')).toBeVisible();
  });

  test('a 202 job that completes then re-confirms shows the confirmed state', async ({ page }) => {
    let confirmCalls = 0;
    await page.route(MERGE_CONFIRM_ENDPOINT, (route) => {
      confirmCalls += 1;
      if (confirmCalls === 1) {
        route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            uid: 'job-1',
            status: 'Pending',
            expectedSeconds: 2,
          }),
        });
      } else {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ kycHash: 'x' }),
        });
      }
    });
    await page.route(MERGE_JOB_ENDPOINT, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ uid: 'job-1', status: 'Complete' }),
      }),
    );
    await page.goto('/account-merge/?otp=abc');
    await expect(page.locator('#state-confirmed')).toBeVisible({ timeout: 10000 });
    expect(confirmCalls).toBe(2);
  });

  test('a 202 ticket already Complete skips job polling and re-confirms', async ({ page }) => {
    let confirmCalls = 0;
    let jobCalls = 0;
    await page.route(MERGE_CONFIRM_ENDPOINT, (route) => {
      confirmCalls += 1;
      if (confirmCalls === 1) {
        route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            uid: 'job-1',
            status: 'Complete',
            expectedSeconds: 2,
          }),
        });
      } else {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ kycHash: 'x' }),
        });
      }
    });
    await page.route(MERGE_JOB_ENDPOINT, (route) => {
      jobCalls += 1;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ uid: 'job-1', status: 'Complete' }),
      });
    });
    await page.goto('/account-merge/?otp=abc');
    await expect(page.locator('#state-confirmed')).toBeVisible({ timeout: 10000 });
    expect(confirmCalls).toBe(2);
    expect(jobCalls).toBe(0);
  });

  test('a 202 ticket already Failed skips job polling and shows unavailable', async ({ page }) => {
    let confirmCalls = 0;
    let jobCalls = 0;
    await page.route(MERGE_CONFIRM_ENDPOINT, (route) => {
      confirmCalls += 1;
      route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          uid: 'job-1',
          status: 'Failed',
          expectedSeconds: 2,
        }),
      });
    });
    await page.route(MERGE_JOB_ENDPOINT, (route) => {
      jobCalls += 1;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ uid: 'job-1', status: 'Failed' }),
      });
    });
    await page.goto('/account-merge/?otp=abc');
    await expect(page.locator('#state-unavailable')).toBeVisible({ timeout: 10000 });
    expect(confirmCalls).toBe(1);
    expect(jobCalls).toBe(0);
  });

  test('a 202 job with expectedSeconds 1 that is Complete on the first job GET still reaches confirmed', async ({
    page,
  }) => {
    let confirmCalls = 0;
    await page.route(MERGE_CONFIRM_ENDPOINT, (route) => {
      confirmCalls += 1;
      if (confirmCalls === 1) {
        route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            uid: 'job-1',
            status: 'Pending',
            expectedSeconds: 1,
          }),
        });
      } else {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ kycHash: 'x' }),
        });
      }
    });
    await page.route(MERGE_JOB_ENDPOINT, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ uid: 'job-1', status: 'Complete' }),
      }),
    );
    await page.goto('/account-merge/?otp=abc');
    await expect(page.locator('#state-confirmed')).toBeVisible({ timeout: 10000 });
    expect(confirmCalls).toBe(2);
  });

  test('after Complete, a second confirm that returns another job-shaped 202 shows unavailable', async ({
    page,
  }) => {
    let confirmCalls = 0;
    await page.route(MERGE_CONFIRM_ENDPOINT, (route) => {
      confirmCalls += 1;
      if (confirmCalls === 1) {
        route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            uid: 'job-1',
            status: 'Pending',
            expectedSeconds: 2,
          }),
        });
      } else {
        // Re-confirm after Complete still returns a job — that is an error, not a new budget.
        route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            uid: 'job-2',
            status: 'Pending',
            expectedSeconds: 60,
          }),
        });
      }
    });
    await page.route(MERGE_JOB_ENDPOINT, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ uid: 'job-1', status: 'Complete' }),
      }),
    );
    await page.goto('/account-merge/?otp=abc');
    await expect(page.locator('#state-unavailable')).toBeVisible({ timeout: 10000 });
    expect(confirmCalls).toBe(2);
  });

  test('a job GET that returns 404 JSON without status shows unavailable without re-polling', async ({
    page,
  }) => {
    let jobCalls = 0;
    await page.route(MERGE_CONFIRM_ENDPOINT, (route) =>
      route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          uid: 'job-1',
          status: 'Pending',
          expectedSeconds: 60,
        }),
      }),
    );
    await page.route(MERGE_JOB_ENDPOINT, (route) => {
      jobCalls += 1;
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'not found' }),
      });
    });
    await page.goto('/account-merge/?otp=abc');
    await expect(page.locator('#state-unavailable')).toBeVisible({ timeout: 10000 });
    expect(jobCalls).toBe(1);
  });

  test('a network error shows the unavailable state', async ({ page }) => {
    await page.route(MERGE_CONFIRM_ENDPOINT, (route) => route.abort());
    await page.goto('/account-merge/?otp=abc');
    await expect(page.locator('#state-unavailable')).toBeVisible();
  });

  test('a 503 response shows the unavailable state', async ({ page }) => {
    await page.route(MERGE_CONFIRM_ENDPOINT, (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
    );
    await page.goto('/account-merge/?otp=abc');
    await expect(page.locator('#state-unavailable')).toBeVisible();
  });

  test('the retry button re-runs the confirmation', async ({ page }) => {
    let calls = 0;
    await page.route(MERGE_CONFIRM_ENDPOINT, (route) => {
      calls += 1;
      const ok = calls > 1; // first attempt fails, the retry succeeds
      route.fulfill({
        status: ok ? 200 : 503,
        contentType: 'application/json',
        body: JSON.stringify(ok ? { kycHash: 'x' } : {}),
      });
    });
    await page.goto('/account-merge/?otp=abc');
    await expect(page.locator('#state-unavailable')).toBeVisible();
    await page.locator('#retry').click();
    await expect(page.locator('#state-confirmed')).toBeVisible();
    expect(calls).toBe(2);
  });

  test('?lang=en renders English copy and sets <html lang="en">', async ({ page }) => {
    await page.goto('/account-merge/?mock=invalid&lang=en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    const expected = await page.evaluate(() => window.RealUnitMerge.I18N.en['invalid.title']);
    await expect(page.locator('#state-invalid h1')).toHaveText(expected);
  });

  test('an empty otp shows the invalid state and makes no confirm request', async ({ page }) => {
    const confirmCalls = [];
    await page.route(MERGE_CONFIRM_ENDPOINT, (route) => {
      confirmCalls.push(route.request().url());
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto('/account-merge/?otp=');
    await expect(page.locator('#state-invalid')).toBeVisible();
    expect(confirmCalls).toEqual([]);
  });

  test('a 404 response shows the invalid state', async ({ page }) => {
    await page.route(MERGE_CONFIRM_ENDPOINT, (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
    );
    await page.goto('/account-merge/?otp=abc');
    await expect(page.locator('#state-invalid')).toBeVisible();
  });

  test('a 202 ticket already DeadLetter skips job polling and shows unavailable', async ({ page }) => {
    let jobCalls = 0;
    await page.route(MERGE_CONFIRM_ENDPOINT, (route) =>
      route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ uid: 'job-1', status: 'DeadLetter', expectedSeconds: 2 }),
      }),
    );
    await page.route(MERGE_JOB_ENDPOINT, (route) => {
      jobCalls += 1;
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto('/account-merge/?otp=abc');
    await expect(page.locator('#state-unavailable')).toBeVisible({ timeout: 10000 });
    expect(jobCalls).toBe(0);
  });

  test('a job that becomes Failed after polling shows unavailable', async ({ page }) => {
    await page.route(MERGE_CONFIRM_ENDPOINT, (route) =>
      route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ uid: 'job-1', status: 'Pending', expectedSeconds: 2 }),
      }),
    );
    await page.route(MERGE_JOB_ENDPOINT, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ uid: 'job-1', status: 'Failed' }),
      }),
    );
    await page.goto('/account-merge/?otp=abc');
    await expect(page.locator('#state-unavailable')).toBeVisible({ timeout: 10000 });
  });

  test('confirmed state shows the RealUnit logo', async ({ page }) => {
    await page.route(MERGE_CONFIRM_ENDPOINT, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ kycHash: 'x' }),
      }),
    );
    await page.goto('/account-merge/?otp=abc');
    await expect(page.locator('#state-confirmed')).toBeVisible();
    await expect(page.locator('img.logo')).toBeVisible();
    await expect(page.locator('img.logo')).toHaveAttribute('src', '/assets/realunit-logo.png');
  });

  test('?lang=de renders German copy and sets <html lang="de">', async ({ page }) => {
    await page.goto('/account-merge/?mock=invalid&lang=de');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    const expected = await page.evaluate(() => window.RealUnitMerge.I18N.de['invalid.title']);
    await expect(page.locator('#state-invalid h1')).toHaveText(expected);
  });

  test('an ?api= override sends the confirmation to that API base', async ({ page }) => {
    let requestedUrl = null;
    await page.route(MERGE_CONFIRM_ENDPOINT, (route) => {
      requestedUrl = route.request().url();
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ kycHash: 'x' }),
      });
    });
    await page.goto('/account-merge/?otp=abc&api=https%3A%2F%2Fapi.example.test');
    await expect(page.locator('#state-confirmed')).toBeVisible();
    expect(requestedUrl).toContain('https://api.example.test/v1/auth/mail/confirm');
    expect(requestedUrl).toContain('code=abc');
  });
});
