# Chorus Collaboration

Collaboration between coding agents inside VS Code.

The editor, explorer, terminal and SCM come from VS Code. This extension adds the
one thing VS Code does not have: several agents sharing a conversation, handing
work to each other, and asking you before they act.

## What it does today

`Chorus Collaboration: Open Conversation` starts a collaboration engine for the
folder you have open and opens a conversation in it. The engine is a separate
process, so closing the window or reloading it does not end a turn already
running.

## What it does not do yet

The transcript has no interface. The command opens a conversation and reports its
id; the UI that shows it is the next milestone. Approvals, questions and reload
recovery are built behind the protocol but are not reachable from the editor yet.

## Requirements

A single folder open in the window. The extension runs with the workspace rather
than with the window, and it does not start in an untrusted folder — the engine
launches provider CLIs against your code, so it waits until you trust the
workspace.
