# Quick Start Guide

Get up and running with OpenROAD MCP in under 5 minutes! This guide assumes you've already [installed OpenROAD MCP](README.md#installation).

> **Runtime:** OpenROAD MCP ships as two interchangeable distributions — `npx` (needs **Node.js 22+**) or `uvx` (needs **Python 3.13+** and `uv`). Either exposes the same tools; pick whichever runtime you already have. See [Standard Configuration](README.md#standard-configuration).

## Verify Your Setup

Check that OpenROAD MCP is loaded in your MCP client:

**Quick test:** Ask your AI assistant:
> "Are OpenROAD tools available?"

If the AI responds with information about OpenROAD MCP tools, you're ready! If not, see the [Installation](README.md#installation) section.

## Your First Command (1 minute)

Let's start with the simplest possible interaction:

### Example 1: Check OpenROAD Version

**You say:**
> "Create an OpenROAD session and show me the version"

**Expected response:**
```
✓ Created session: session-abc123

OpenROAD v2.0-14023-g05f7f46af
Built: Nov 20 2024
```

**What happened:**
- AI called `create_interactive_session()` to create a new session
- AI called `interactive_openroad("openroad -version", session_id)` to run the command
- You got immediate feedback without touching the command line

### Example 2: List Active Sessions

**You say:**
> "Show me all active OpenROAD sessions"

**Expected response:**
```json
{
  "sessions": [
    {
      "session_id": "session-abc123",
      "is_alive": true,
      "command_count": 1,
      "created_at": "2025-12-05T10:30:00"
    }
  ],
  "total_count": 1,
  "active_count": 1
}
```

✅ **Success!** You've just run your first OpenROAD commands through AI assistance.

## Try a Real Design Analysis (3 minutes)

Now let's do something more interesting: analyze timing on a real design.

### Option A: If You Have ORFS Installed

If you have OpenROAD-flow-scripts with the GCD design built:

**You say:**
> "Load the nangate45 GCD design and show me timing analysis"

**AI will execute:**
```tcl
# Load technology
read_lef /path/to/ORFS/platforms/nangate45/lef/NangateOpenCellLibrary.tech.lef
read_lef /path/to/ORFS/platforms/nangate45/lef/NangateOpenCellLibrary.macro.lef
read_liberty /path/to/ORFS/platforms/nangate45/lib/NangateOpenCellLibrary_typical.lib

# Load design
read_verilog /path/to/ORFS/results/nangate45/gcd/base/1_synth.v
link_design gcd

# Load constraints and analyze
read_sdc /path/to/ORFS/results/nangate45/gcd/base/6_final.sdc
report_checks -digits 3
```

**Expected output:**
```
Startpoint: dpath.a_reg.out[10]$_DFFE_PP_
Endpoint: dpath.b_reg.out[10]$_DFFE_PP_
Path Group: core_clock
Path Type: max

   Delay     Time   Description
-----------------------------------------------------------
   0.000    0.000   clock core_clock (rise edge)
   ...
            0.039   slack (MET)
```

### Option B: Simple Commands Without ORFS

Don't have ORFS? Try these basic commands:

**You say:**
> "Create a clock named 'clk' with 10ns period"

**AI executes:** `create_clock -name clk -period 10 [get_ports clk]`

**You say:**
> "Show me what clocks are defined"

**AI executes:** `report_clocks`

## Common Usage Patterns

Now that you've run basic commands, here are common workflows:

### Session Management

| What You Want | What You Say |
|---------------|--------------|
| Start a new session | "Create a new OpenROAD session" |
| Start a named session | "Create a session called 'timing-debug'" |
| See all sessions | "List all my OpenROAD sessions" |
| Close a session | "Terminate session-abc123" or "Close my timing-debug session" |
| Get session details | "Show me details for session-abc123" |

### Timing Analysis

| What You Want | What You Say |
|---------------|--------------|
| Check overall timing | "What's the worst slack in this design?" |
| Find violations | "Show me all paths with negative slack" |
| Analyze specific path | "Show timing from register A to register B" |
| Check setup vs hold | "Show me hold violations" |
| Get top violators | "What are the 10 worst timing paths?" |

### Design Information

| What You Want | What You Say |
|---------------|--------------|
| Design statistics | "How many instances are in this design?" |
| Clock information | "What clocks are defined?" |
| Port information | "List all input ports" |
| Net fanout | "What's the fanout of net XYZ?" |
