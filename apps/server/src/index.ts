import { buildApp } from './app.js'

const PORT = Number(process.env.COWRITE_PORT ?? 2697)
const HOST = process.env.COWRITE_HOST ?? '127.0.0.1'

const app = buildApp()

app
  .listen({ port: PORT, host: HOST })
  .then((address) => {
    console.log(`cowrite listening at ${address}`)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.close().then(() => process.exit(0))
  })
}
