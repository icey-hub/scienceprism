# Selected-text translation API

The PDF reader uses the project's translation service. Its currently runnable
sources are `bing-web` and `google-web`, both without a user API key. Their
availability and throttling depend on the upstream service. Azure Translator and
Google Cloud Translation are not enabled by this implementation.

## Project settings

Use `GET /api/projects/:id/translation/settings` to read `revision`, `settings`
and application `usage`. Update settings through `PATCH` on the same URL:

```json
{
  "expectedRevision": 0,
  "patch": {
    "defaultProviderId": "google-web",
    "targetLanguage": "ja",
    "automatic": false,
    "cache": { "enabled": true },
    "monthlyCharacterLimit": 100000
  }
}
```

A stale revision returns `409 TRANSLATION_SETTINGS_CONFLICT`; reload before
saving. Cache options also include `ttlMs` (1 second to 24 hours) and `maxEntries`
(1–2000). Default content caching is 30 minutes and 200 entries. Changing settings
does not edit PDF annotations or enable a paid provider. The reader's right panel saves the source, target language and automatic
translation to the project. Its ‘Usage and cache’ section controls the monthly
application limit, cache lifetime and entry count. Refresh reloads current
settings and usage; conflicting saves require an explicit reload before retry.

## Request identity and caching

`POST /api/projects/:id/translations` accepts selected text, `selectionId`, an
optional PDF `source`, source/target languages, provider and `operationId`. Use
the same operation ID only to observe or retransmit the same logical request.
Different text, selection or source under that ID returns a conflict. Omitting
provider/target language uses saved project defaults. Older clients may omit the
ID; the backend generates one, but cannot identify their repeated HTTP requests.

An in-flight request or a retained result is shared without another provider
call. Content caching can reuse the same translation for another selection while
returning that selection's own context. Cached requests retain their operation
identities and do not consume characters.

`DELETE /api/projects/:id/translation/cache` clears the project's content cache
and retained completed results. Late responses cannot refill the cleared cache.
Operation identities remain on disk. After clearing, eviction or restart, an
already recorded request with no retained result returns
`409 TRANSLATION_RESULT_UNAVAILABLE` rather than contacting the provider again.
A deliberately new request needs a new ID and remains subject to its budget.
The reader retains the same ID while retrying its current selection and language.
After a failed request, its explicit new-request action warns that earlier
reservations remain and another request may consume additional characters.

## Application usage

`GET /api/projects/:id/translation/usage` reports estimated Unicode character
counts, including whitespace, in an explicit UTC monthly period. The optional
project limit is shared across both sources. It is this application's limit,
not a provider's billing balance or a guarantee of free official API usage.

Network requests reserve characters before dispatch. Successful requests consume
the reservation; sent requests with uncertain outcomes retain it, including
after restart or month rollover. Only a request known not to have been dispatched
can release its reservation. Source health reflects source requests; local quota
or storage failures do not mark the source unavailable.

Settings and identity receipts are stored in `.scienceprism/translation.json`
without original text, translations or credentials. The default ledger retains
up to 4096 identities and 4 MiB; full storage rejects new identities while
preserving existing ones. This owner supports one backend process per data
directory. Multi-process accounting, receipt archival/reconciliation controls,
official provider budgets, terminology and model explanations need subsequent
integration.
