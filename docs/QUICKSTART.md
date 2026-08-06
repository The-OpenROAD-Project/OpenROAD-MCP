# OpenROAD MCP – Quick Start Guide

Get to "it works" in under 5 minutes. This guide assumes you have already configured your MCP client according to the [Requirements & Installation](README.md#requirements--installation) instructions.

## 1. The "It Works" Check

Before diving into physical design, verify your AI assistant is connected to the server.

**What to say:**
> "Are your OpenROAD tools available and ready to use?"

**What to expect:**
The AI should acknowledge it has access to tools like `interactive_openroad_query`, `create_interactive_session`, and `read_report_image`.

*(If it says no, double-check your MCP client configuration and ensure `openroad` is in your `PATH`.)*

## 2. Your First Command

Let's start by having the AI spin up an interactive OpenROAD session and run a simple command.

**What to say:**
> "Create a new OpenROAD session and tell me what version of OpenROAD we are running."

**What the AI will do:**
1. Call `create_interactive_session()`
2. Call `interactive_openroad_query("version")`

**What to expect:**
A short response directly in your chat:
`OpenROAD v2.0-14023-g05f7f46af`

## 3. Real Design Analysis

If you have OpenROAD-flow-scripts (ORFS) configured via `ORFS_FLOW_PATH`, you can ask the AI to load a real design and analyze it.

**What to say:**
> "Load the nangate45 GCD design from ORFS and show me the worst setup slack."

**What the AI will do:**
It will use `interactive_openroad_exec` to run a sequence of Tcl commands that load the technology and design:
```tcl
read_lef /path/to/flow/platforms/nangate45/lef/NangateOpenCellLibrary.tech.lef
read_lef /path/to/flow/platforms/nangate45/lef/NangateOpenCellLibrary.macro.lef
read_liberty /path/to/flow/platforms/nangate45/lib/NangateOpenCellLibrary_typical.lib
read_verilog /path/to/flow/results/nangate45/gcd/base/1_synth.v
link_design gcd
read_sdc /path/to/flow/results/nangate45/gcd/base/6_final.sdc
report_checks -digits 3
```

**What to expect:**
A standard OpenROAD timing report detailing the startpoint, endpoint, and slack for the worst path, all without touching the terminal yourself.

## 4. Common Prompt Patterns

Here are some proven, plain-English prompts you can use to drive OpenROAD through your AI assistant.

### Session Management
* **Start:** *"Create a new OpenROAD session named 'timing-debug'."*
* **List:** *"Show me all my active OpenROAD sessions."*
* **Cleanup:** *"Terminate all my OpenROAD sessions."*

### Timing & Power Analysis
* **Slack:** *"What is the worst negative slack in the current design?"*
* **Violations:** *"Show me the top 10 timing paths with setup violations."*
* **Hold:** *"Are there any hold violations? If so, show me the worst one."*
* **Power:** *"Run a power report and summarize the total internal vs switching power."*

### Design Introspection
* **Clocks:** *"What clocks are defined in this design, and what are their periods?"*
* **Hierarchy:** *"How many macros and standard cell instances are in this design?"*
* **Nets:** *"Find the net named 'clk' and tell me its fanout."*

### ORFS Reports & Visuals
* **List Images:** *"What report images are available for the 'gcd' design on 'nangate45'?"*
* **View Congestion:** *"Show me the placement congestion report image for the GCD design."*
