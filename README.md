# Search Internal Files

This is a local web app that scans the `Sandeep Taterway - Mergen Compass` OneDrive folder, indexes readable business files, and lets you search for exact terms, related phrases, or broader concept matches.

It starts with a fresh in-memory index each time the server starts. It does not reuse files read by another copy of the app.

## Run

Double-click `start-search-internal-files.cmd`, or run this if Node is available on your PATH:

```powershell
npm start
```

Then open:

```text
http://127.0.0.1:5199
```

If the app was started by another tool and files do not open visibly in Windows, double-click `restart-search-internal-files.cmd`. It stops the copy using port `5199` and starts the app under your current Windows session.

## Supported files

- Word: `.docx`, plus best-effort `.doc`
- PowerPoint: `.pptx`, plus best-effort `.ppt`
- Excel: `.xlsx`, plus best-effort `.xls`
- PDF: `.pdf`
- Text-like files: `.txt`, `.md`, `.csv`

The app reads local files only. Search results include snippets plus buttons to open the file or show it in its folder.
