# Selected-text translation API

The PDF reader uses the project's translation service. Its currently runnable
default sources are `bing-web` and `google-web`, both without a user API key.
Their availability and throttling depend on the upstream service. Optional
`azure-api` and `google-cloud` use their official HTTPS APIs and require explicit
server configuration and enablement. They share the same project settings,
request identity, character accounting and cache. There is no automatic fallback.

## Official service configuration

Set `SCIENCEPRISM_TRANSLATION_AZURE_ENABLED=true` and
`SCIENCEPRISM_TRANSLATION_AZURE_KEY` to enable Azure Translator. Set
`SCIENCEPRISM_TRANSLATION_AZURE_REGION` for a regional or multi-service resource.
Google Cloud uses `SCIENCEPRISM_TRANSLATION_GOOGLE_ENABLED=true` and
`SCIENCEPRISM_TRANSLATION_GOOGLE_KEY`. Supplying a key alone does not enable a
source. Keys stay on the backend and never appear in provider status or saved
project settings. Arbitrary endpoints, redirects and implicit retries are rejected.

The reader shows disabled/unconfigured official sources separately from the
last observed request health. Configuration does not prove API availability.
Official free allowances depend on the account and plan; billing may need to be
enabled, and the application cannot query or guarantee the vendor's balance.
Use the [Azure setup guide](https://learn.microsoft.com/azure/ai-services/translator/translator-how-to-signup)
or [Google Cloud setup guide](https://cloud.google.com/translate/docs/setup).
No glossary or model explanation is sent by these translation providers.

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
project limit is shared across all sources. It is this application's limit,
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
directory. Multi-process accounting, receipt archival/reconciliation controls
and vendor-account budget reconciliation need subsequent integration.

## Reading glossary

The reader's **Terms** tab stores human definitions at project scope. A term may
link to a PDF selection (paper, attachment SHA-256, page, quote and rectangles).
Saving verifies the actual attachment version and page; the link identifies the
reader selection, without claiming OCR or semantic verification of the quote.
Definitions do not replace translations or configure provider-native glossaries.

`GET /api/projects/:id/reading-glossary` returns `entries` and a numeric `revision`.
Create with `POST {expectedRevision, entry}`, edit with
`PATCH /:entryId {expectedRevision, patch}`, and delete with
`DELETE /:entryId {expectedRevision}`. Writes require the existing human actor
header, `x-scienceprism-actor: human`. Entries contain `term`, `definition`,
`sourceLanguage`, `targetLanguage`, and optional `source`; setting `source` to
`null` detaches it. Server-generated IDs and timestamps cannot be supplied.
A stale revision returns `409 GLOSSARY_CONFLICT`; refresh retains unsaved input
for review. The project file `.scienceprism/reading-glossary.json` is written
atomically and supports up to 1,000 entries, 200-character terms and
4,000-character definitions.

## Selected-text AI explanations

The **AI explanation** tab calls the configured DeepSeek Harness only after an
explicit click. It accepts the current selection and an optional question, uses
the existing project token/time limits, and grants no file, network or execution
tools. It does not silently fall back to another runtime or translation provider.
The answer is a model interpretation, separately labelled from the original text
and translation, and is not automatically saved into the manuscript or glossary.

`POST /api/projects/:id/papers/:paperId/explanations` accepts
`{requestId, selection, targetLanguage, question?}`. The selection includes `id`,
`text`, `page`, `fileSha256`, `attachmentId` and normalized `rects`. The server
verifies the owned PDF bytes, version and page before creating the original
Harness Run with source `paper-reading`. The response is `{run}`; results live in
`run.reply`, and `run.request.readingSource` preserves the input provenance.
The browser cannot override model credentials or tool permissions.

The same request ID returns the original Run, including after cancellation or
restart; different input under that ID is rejected. Existing Run APIs provide
status and cancellation. `GET` on the explanation URL returns the latest 100
Runs for that paper. Refreshing history or switching selections does not launch
a model request. Results remain attached to their original selection.
