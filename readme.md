# subrepo-install

**The easy way to set up a standalone [subrepo](https://github.com/ingydotnet/git-subrepo) outside its monorepo.**

> NOTE: This tool is intended for JavaScript and TypeScript projects using [pnpm](https://pnpm.io/) only!

```
pnpm add subrepo-install
```

### How it works

Use **subrepo-install** in a `postinstall` script to clone dependencies that would otherwise be provided by a monorepo. If a dependency always needs to be cloned, you can do that too.

This approach is specifically designed to work well with [git-subrepo](https://github.com/ingydotnet/git-subrepo).

If **subrepo-install** is used in a workspace context, it will realize this automatically and link to the monorepo-provided dependencies instead of cloning them.

Additionally, you can inherit dependencies from these sub-dependencies by setting the `inheritDependencies` option. This is similar to pnpm's [Catalogs](https://pnpm.io/catalogs) feature, but is designed to work with `git-subrepo`.
