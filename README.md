# Farsh

The Arabic-first interface of فرصة (Forsah), a paper-trading platform. Nuxt 4, Vue 3, Tailwind CSS 4.

- `npm ci`
- `npm run dev`: development, with the backend running on port 8787
- `npm run build`: writes the static site to `.output/public`
- `npm test`: checks that no technical wording reaches readers

The backend lives in the sibling folder `dar-al-tharaa` and serves `.output/public` from here.
Its Docker build reads this folder too, so keep both folders side by side
(or set `FORSAH_WEB_DIR` for the server and `FARSH_DIR` for Docker).
