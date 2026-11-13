# onedrive-cli

Cross-platform command line interface for OneDrive: personal accounts, and
work or school accounts (OneDrive for Business)

## Installation

With `npm`:

```sh
npm install -g @lionello/onedrive-cli
```

That installs the command as `onedrive`, with `onedrive-cli` as an alias for it.

Or with `nix-env`:

```sh
nix-env -if https://github.com/lionello/onedrive-cli/archive/master.tar.gz -A package
```

Or from source:

```sh
git clone https://github.com/lionello/onedrive-cli.git
cd onedrive-cli
npm install
bin/onedrive login
```

## Getting started

Sign in once, then use the drive like a filesystem:

```sh
onedrive login          # opens the Microsoft sign-in page in your browser
onedrive df             # check the connection and storage usage
onedrive ls             # list your drive root
```

Personal Microsoft accounts and work or school accounts both work: the CLI
talks to [Microsoft Graph](https://learn.microsoft.com/graph/onedrive-concept-overview),
and with a work or school account `:/` is your OneDrive for Business.

`login` saves the sign-in to `~/.onedrive-cli-token` (or `$XDG_STATE_HOME` if
that is set), readable by you only. It renews itself, so you stay signed in
until you run `onedrive logout`. Add `-r` for read-only access.

## Signing in

-   `onedrive login` - opens your browser, which hands the sign-in straight
    back to the CLI.
-   `onedrive login --device` - prints a short code to enter at
    microsoft.com/devicelogin on any device: for SSH sessions, containers and
    agents. Used automatically when there is no terminal.
-   `onedrive login --tenant contoso.com` - accepts accounts of that
    organization only (a domain or tenant ID). The default, `common`, accepts
    any account.
-   `onedrive login -r` - read-only access (`Files.Read.All` instead of
    `Files.ReadWrite.All`).
-   `onedrive logout` - deletes the saved sign-in.

`login <access_token>` still saves a token obtained elsewhere. Such a token
cannot be renewed and stops working after about an hour.

### Your own app registration

Some organizations only let their users sign in to apps an administrator has
approved. Either ask an administrator to approve onedrive-cli, or register your
own app (free, a few minutes):

1. In the [Microsoft Entra admin center](https://entra.microsoft.com), open
   **App registrations** and choose **New registration**. Pick the account
   types you need.
2. Under **Authentication**, add the platform **Mobile and desktop
   applications** with the redirect URI `http://localhost`, and set **Allow
   public client flows** to _Yes_ (needed for `--device`).
3. Under **API permissions**, add the delegated Microsoft Graph permissions
   `Files.ReadWrite.All` (or `Files.Read.All`) and `offline_access`.

Then sign in with its _Application (client) ID_:

```sh
onedrive login --client-id 00000000-0000-0000-0000-000000000000 --tenant contoso.com
```

or set `ONEDRIVE_CLIENT_ID` (and `ONEDRIVE_TENANT`) in the environment. Both are
saved with the sign-in, so renewals keep using them.

### National clouds

Point the CLI at the cloud's endpoints, e.g. for US Government:

```sh
export ONEDRIVE_AUTHORITY_HOST=https://login.microsoftonline.us
export ONEDRIVE_GRAPH_URL=https://graph.microsoft.us/v1.0
```

## Usage

`usage: onedrive COMMAND [arguments]`

Run `onedrive help` (or `-h`/`--help`) for this list at any time, and
`onedrive --version` for the installed version. The commands are:

-   `album` - list, create, or edit photo albums (`ls`/`create`/`add`/`rm`)
-   `cat` - dumps the contents of a file to stdout
-   `chmod` - change sharing permissions
-   `cp` - copies local file(s) to OneDrive or vice-versa
-   `df` - shows OneDrive storage usage stats
-   `find` - find file(s) or folder(s) by name, optionally separated by `NUL`
-   `grep` - full-text search across the drive, listing matching paths
-   `help` - shows list of supported commands
-   `ln` - create a link to the remote item
-   `login` - sign in (browser, or `--device` for a code), see [Signing in](#signing-in)
-   `logout` - delete the saved sign-in
-   `ls` - list the contents of a folder
-   `mcp` - run a read-only [MCP](https://modelcontextprotocol.io) server over stdio
-   `mkdir` - create a remote folder
-   `mv` - move a local file to OneDrive or vice-versa
-   `rm` - delete a file or folder from OneDrive
-   `sendmail` - send an invitation email for editing to recipients
-   `stat` - dump all information for particular file(s)
-   `wget` - copy a remote URL to OneDrive (server side)

## Examples

##### List the contents of the Public folder

`onedrive ls Public`

##### Grep one file

`onedrive cat Documents/passwords | grep boa`

##### Let OneDrive upload a file server side

`onedrive wget http://mega.com/somehugepublicfile Documents/somehugepublicfile`

##### Upload files recursively

`find * -type f -print0 | xargs -0 -n1 -I{} onedrive cp "./{}" "Shared Favorites/{}"`

##### Move remote files to a new folder

`onedrive find 'Pictures/Camera Roll' -regex 2015 -type f -print0 | xargs -0 onedrive mv -t :/Pictures/2015/`

##### Create an album and add photos to it

```sh
onedrive album create 'Summer 2026'
onedrive album add 'Summer 2026' 'Pictures/Camera Roll/IMG_1234.jpg'
onedrive albums                # list all albums
onedrive albums 'Summer 2026'  # list the photos in one album
```

Albums are OneDrive [bundles](https://learn.microsoft.com/graph/api/drive-list-bundles),
which exist on personal accounts only:
they live outside the folder hierarchy and only reference the files, so
`album rm` removes a photo from the album without deleting the file.
Deleting an album itself is not supported by the API — use the OneDrive
web UI for that.

## MCP server

`onedrive mcp` starts a read-only [Model Context Protocol](https://modelcontextprotocol.io)
server over stdio, so an MCP client (Claude, etc.) can browse and read your
OneDrive. It reuses the saved sign-in, so `login` first — ideally with
`login -r` for read-only access — or let the agent call `login_onedrive`. The
server only issues `GET` requests and cannot modify the drive. It exposes these
tools:

-   `list_onedrive_folder` - list the direct children of a folder
-   `search_onedrive_content` - full-text search across the whole drive
-   `find_onedrive_files` - recursively find items by name glob
-   `list_onedrive_albums` - list the photo albums, or the items in one album
-   `read_onedrive_file` - read a file's contents as text
-   `stat_onedrive_item` - return full metadata for an item
-   `onedrive_storage` - report storage quota for the available drives
-   `login_onedrive` - sign in: a browser link, or with `device: true` a code
    to enter on any device

Register it with your MCP client, e.g. in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "onedrive": {
      "command": "onedrive",
      "args": ["mcp"]
    }
  }
}
```

## FAQ

##### You're not logged in. Run 'onedrive login' to sign in.

The `onedrive` utility needs a sign-in to read/write your OneDrive. Run
`onedrive login`: it opens the Microsoft sign-in page, and the browser hands the
result straight back to the waiting command, which saves it to
`~/.onedrive-cli-token`. If the browser runs on another machine, use
`onedrive login --device` instead. See [Signing in](#signing-in).

##### Your sign-in has expired and could not be renewed.

The saved sign-in renews itself, but an organization can revoke it (e.g. after
a password change), and a token from an older version of onedrive-cli, made for
the retired OneDrive API, cannot be renewed at all. Run `onedrive login` again.

##### "An item with the same name already exists under the parent"

Currently, a copy will fail if a file with the same it already exists.
Change the name of the target, or use other means to delete/rename the existing file in your OneDrive.

##### Invalid source name

You cannot copy folders. Specify a source file instead, or use wildcards.

##### Invalid target name

The target file name cannot be determined from the source path. Specify a target file name.

##### Use ./ or :/ path prefix for local or remote paths.

The `cp` command supports both local->remote as well as remote->local copy.
To make it clear which path is remote and which is local, either use `./` as a prefix for
the local path, or use `:/` as a prefix for the remote path. Either one will suffice.

##### chmod: Invalid file mode

The `chmod` command currently only supports `-w` or `-rw`. The former tried to downgrade _write_
shares to _read_-only, whereas the latter removes all shares for the given item(s). Octal modes are accepted (for example `644`, `0700`) as well as `og-rw` or `g-w`.

<!-- readme-only:start -->

## TODO

Tracked on the [issue tracker](https://github.com/lionello/onedrive-cli/issues),
so this stays a pointer rather than a second source of truth:

-   [#36](https://github.com/lionello/onedrive-cli/issues/36) — skip the transfer when the SHA1 already matches
-   [#34](https://github.com/lionello/onedrive-cli/issues/34) — `chmod`: granting write access (`+w`)
-   [#37](https://github.com/lionello/onedrive-cli/issues/37) — confirm the API honours gzip/deflate on downloads

## DONE

-   Resumable upload sessions for files over 4 MiB, so large files upload without size limit or holding them in memory ([#33](https://github.com/lionello/onedrive-cli/issues/33))
-   Microsoft Graph, so work and school accounts work too, with a sign-in that renews itself ([#8](https://github.com/lionello/onedrive-cli/issues/8), [#4](https://github.com/lionello/onedrive-cli/issues/4))
-   Read-only [MCP](https://modelcontextprotocol.io) server (`onedrive mcp`)
-   Photo albums via bundles (`onedrive album`)
-   Full-text search across the drive (`onedrive grep`)
-   Capture the OAuth token over a loopback listener instead of copy-paste
-   Delete files and folders (`onedrive rm`)
-   Get the sharing link for a file (`onedrive ln`)
-   Register with NPM ([@lionello/onedrive-cli](https://www.npmjs.com/package/@lionello/onedrive-cli))
-   Fixed OAuth redirect on Safari (https://bugs.webkit.org/show_bug.cgi?id=24175)
-   Use XDG path spec for token file (https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html)
-   Using `async`/`await`

<!-- readme-only:end -->

## Development

`npm test` runs the tests, including the CLI end to end against a local mock of
Microsoft Graph and the sign-in endpoints (`test/helpers/mock-graph.js`), so no
account or network is needed. `npm run lint` and `npm run format` keep the style.

A [Nix](https://nixos.org) flake provides the package and a dev shell with all
dependencies. Run `nix develop` (or use [Direnv](https://direnv.net)'s `use flake`)
for the shell, and `nix build` / `nix run` to build or run the CLI. The legacy
`shell.nix` still works with `nix-shell`.

### Update the dependency hash

After changing `package-lock.json`, refresh `npmDepsHash` in `flake.nix`:

```sh
nix run nixpkgs#prefetch-npm-deps -- package-lock.json
```

### Regenerate the website

`docs/index.html` is generated from this README:

```sh
npm run readme
```
