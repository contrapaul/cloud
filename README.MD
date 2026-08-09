# cloud.contrapaul.com

A live, collaborative word cloud. Ask a room a question, everyone answers on
their phone, and taps the answers they agree with to make them grow. Built so a
single idea gets one big bubble instead of six fragmented spellings.

No accounts. Fully anonymous. Nothing asks for a name.

See [PLAN.md](PLAN.md) for the design and the phase plan.

## Running it locally

Two processes, because the Durable Object lives in its own Worker and the Pages
dev server connects to it over the local dev registry. Both must be running.

```
npm install
npm run do     # the room Worker, port 8787
npm run dev    # the Pages site,  port 8789
```

Then open http://localhost:8789.

## Deploying

```
npm run deploy:do    # the room Worker, deploy this first
npm run deploy       # the Pages site
```

The Worker has to go first on any change that alters the Durable Object's
interface, or the live site will be calling a method that is not there yet.

## Layout

| Path | What |
|---|---|
| `public/` | the static site, served as is |
| `public/js/vendor/` | third party code, committed on purpose so nothing is fetched at runtime |
| `public/data/profanity.txt` | the blocklist, single source of truth, edit and push |
| `functions/api/` | Pages Functions, the only thing that talks to the DO |
| `workers/cloud-live/` | the Durable Object, one instance per share code |

## Two rules that are easy to break

**Nothing is fetched from another host, ever.** Fonts come from
`public/fonts/`, third party scripts from `public/js/vendor/`. No CDN, no
`fonts.googleapis.com`, no `fonts.gstatic.com`. Those are unreachable in China
and a blocking request to a dead host stops the page loading. If you add a
font, commit the woff2. If you add a library, commit the built file and note
where it came from.

**No em dash characters.** Not in the UI, not in comments, not in docs. Use a
comma, a full stop or a colon.
