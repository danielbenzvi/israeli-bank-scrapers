---
title: Cibus (Pluxee)
source-files:
  - src/Scrapers/Cibus/CibusScraper.ts
  - src/Scrapers/Cibus/CibusPost.ts
  - src/Scrapers/Cibus/CibusMapping.ts
  - src/Scrapers/Cibus/CibusPageScripts.ts
  - src/Scrapers/Cibus/Config/CibusApiConfig.ts
status: new
---

# Cibus (Pluxee)

An employer-funded **meal-benefit portal**, not a bank or a card issuer. Like
[Behatsdaa](behatsdaa.md), it is a benefit source registered through the same
public API, so `createScraper` and the result shape are unchanged.

|                |                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `CompanyTypes` | `Cibus`                                                                                                                                        |
| Engine         | **Legacy** (`BaseScraperWithBrowser`) — **not on Pipeline**                                                                                    |
| Credentials    | `username`, `password`, optional `company`                                                                                                     |
| OTP            | Yes — one-time code, with an optional ~30-day device token                                                                                     |
| Registry       | `SCRAPER_REGISTRY_AMEX_TO_ISRACARD` (alphabetical A–I half)                                                                                    |
| Source         | [`src/Scrapers/Cibus/CibusScraper.ts`](https://github.com/sergienko4/israeli-bank-scrapers/blob/{{BRANCH}}/src/Scrapers/Cibus/CibusScraper.ts) |

## Quick example

```typescript
const result = await scraper.scrape({
  username: 'myuser',
  password: 'mypassword',
  // Only some employers require this. The provider's own pre-auth call
  // decides, and the scraper asks it before sending credentials.
  company: 'my-employer',
});
```

## What is different about this source

**Some employers need a third credential, some don't.** There is an optional
`company` field. Rather than guess, the scraper asks the provider first, in a
separate call made before any credentials are sent. It has its own credential
type so that no other scraper picks up a field it never uses.

**Logging in may ask for a one-time code.** When it does, the provider answers
the password step with HTTP **210** — a made-up status code, not a standard one.

That matters more than it sounds. If you treat any unexpected status as a
failure, you report "wrong password" to someone whose password was fine, and
they go and change it for no reason. So the scraper reads the status itself.
That is the only reason it has its own
[`CibusPost.ts`](https://github.com/sergienko4/israeli-bank-scrapers/blob/{{BRANCH}}/src/Scrapers/Cibus/CibusPost.ts)
instead of using the shared in-page POST, which returns the body alone.

Passing an `otpLongTermToken` from an earlier login skips the code for about 30
days.

**Every request needs its own reCAPTCHA token.** The tokens are single-use and
tied to the specific action they were minted for. Send the same one twice and
the second call is rejected with a 401 — the identical answer you get for a
wrong password, so the mistake is invisible. The scraper mints a fresh token per
request, and reads the action names from the live page rather than hardcoding
guesses.

**The account has a benefit allowance, not a balance.** Those are different
quantities, so the allowance is not written into `balance`. It goes in
`providerExtra`, along with its expiry date. This library does not read or
validate anything in that field — a consumer re-types it at its own boundary.

`providerExtra` holds **data only, never credentials.** Session values leave
through `onAuthFlowComplete` instead.

**It runs on the legacy scraper, not the Pipeline.** Pipeline's captcha support
detects a challenge iframe and clicks a checkbox. reCAPTCHA v3 is invisible:
there is no iframe and nothing to click, and a fresh token has to be attached to
each request. Pipeline has no hook for that today, so this follows the
[Behatsdaa](behatsdaa.md) precedent and drives the flow directly.

## Read-only by construction

A benefit portal is different from a bank in one way that matters: if you are
logged in, you could in principle **spend**. This scraper must only ever read.

Rather than trust that nobody later adds a call that spends, every request is
checked against a list of allowed URLs in
[`Config/CibusApiConfig.ts`](https://github.com/sergienko4/israeli-bank-scrapers/blob/{{BRANCH}}/src/Scrapers/Cibus/Config/CibusApiConfig.ts).
A unit test asserts that the URLs the scraper can reach are exactly that list —
no more, no fewer. Add an endpoint and the test fails. That is what makes this a
property of the code rather than a promise in a comment.

Four URLs are allowed. Three are the `/auth/*` posts, and the only thing they
write is a session. The fourth reads transactions.
