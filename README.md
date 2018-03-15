# onedrive-cli
Cross-platform command line interface for OneDrive (Personal)

## Installation
```
$ git clone https://github.com/enumatech/onedrive-cli.git
$ cd onedrive-cli
$ npm install
$ ln -s $(realpath bin/onedrive) ~/bin/onedrive
$ onedrive login
```
## Usage
`usage: onedrive COMMAND [arguments]`

This little utility supports the following commands:
* `cat` - dumps the contents of a file to stdout
* `chmod` - change sharing permissions
* `cp` - copies a local file to OneDrive or vice-versa
* `df` - shows OneDrive storage usage stats
* `help` - shows list of supported commands
* `ln` - create a link to the remote item
* `login` - request/store an OAuth access token
* `ls` - list the contents of a folder
* `mv` - move a local file to OneDrive or vice-versa
* `rm` - delete a file from OneDrive (not implemented)
* `sendmail` - send an invitation email for editing to recipients
* `stat` - dump all information for a particular file
* `wget` - copy a remote URL to OneDrive (server side)

## Examples
##### List the contents of the Public folder
`onedrive ls Public`

##### Grep one file
`onedrive cat Documents/passwords | grep boa`

##### Let OneDrive upload a file server side
`onedrive wget http://mega.com/somehugepublicfile Documents/somehugepublicfile`

##### Upload files recursively
`find * -type f -print0 | xargs -0 -n1 -I{} onedrive cp "./{}" "Shared Favorites/{}"`

## FAQ
##### Access token was not found; 'login' first.
The `onedrive` utility needs an access token in order to read/write to your OneDrive storage.
Use the`onedrive login` command to get the address of the Microsoft login page. After login,
this page will redirect to the file `oauthcallbackhandler.html` (https://github.com/enumatech/onedrive-cli/blob/master/docs/oauthcallbackhandler.html)
and extract the `access_token` from the URL parameters. Copy-paste this token into the command line.
This will save the token in a file called `~/.onedrive-cli-token`. These tokens have a validity of 1 hour.

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
The `chmod` command currently only supports `-w` or `-rw`. The former tried to downgrade *write*
shares to *read*-only, whereas the latter removes all shares for the given item(s). Octal modes are accepted (for example `644`, `0700`) as well as `og-rw` or `g-w`.

## TODO
* Implement `rm`
* Register with NPM
* Support gzip/deflate encoding for downloads
* Uploads larger than 100MiB are not yet supported (needs range API)
* Support OneDrive for Business
* Ability to get the link for a file

## DONE
* Fixed OAuth redirect on Safari (https://bugs.webkit.org/show_bug.cgi?id=24175)
