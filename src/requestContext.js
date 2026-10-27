/**
 * Who is doing the current request — read by code deep below the routes (e.g. which mailbox an email goes out
 * from) without passing the user through every call. Empty for background jobs.
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();
const middleware = (req, res, next) => als.run({ user: req.user || null }, next);
const currentUser = () => als.getStore()?.user || null;

module.exports = { middleware, currentUser, run: (ctx, fn) => als.run(ctx, fn) };
