# conveno.dev

The one-page site at https://conveno.dev. Plain HTML and the brand assets, served as static files by Cloudflare Workers.

Deploy from this folder with `npx wrangler deploy`. It needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment. The images in `public/assets` are copies of files in `brand/assets`; copy them again when the brand changes.
