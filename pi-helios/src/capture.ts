import { stat } from "node:fs/promises";
import type { ExecResult } from "@earendil-works/pi-coding-agent";

export type Exec = (command: string, args: string[], options?: { signal?: AbortSignal; timeout?: number; cwd?: string }) => Promise<ExecResult>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function validatePng(data: Buffer): void {
  if (data.length === 0) throw new Error("Screenshot command produced an empty image");
  if (data.length > MAX_IMAGE_BYTES) throw new Error("Screenshot exceeds 25MB limit");
  if (data.length < PNG_SIGNATURE.length || !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Screenshot command did not produce a PNG image");
  }
}

async function outputCreated(path: string): Promise<boolean> {
  try { return (await stat(path)).size > 0; } catch { return false; }
}

export function loopbackUrl(value: string, protocols: readonly string[]): URL {
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`Helios only permits loopback ${protocols.join("/")} endpoints`);
  }
  return url;
}

function failed(command: string, result: ExecResult): Error {
  const reason = result.stderr.trim() || `exit code ${result.code}`;
  return new Error(`${command} screenshot failed: ${reason}`);
}

export interface WindowTarget {
  handle: number;
  processId: number;
  title: string;
}

const WINDOWS_NATIVE_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

namespace PiHelios {
  public struct Rect { public int Left, Top, Right, Bottom; }
  public sealed class WindowTarget {
    public long Handle { get; set; }
    public uint ProcessId { get; set; }
    public string Title { get; set; }
  }

  public static class Native {
    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr state);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

    private static string TitleOf(IntPtr hwnd) {
      int length = GetWindowTextLength(hwnd);
      if (length <= 0) return "";
      var text = new StringBuilder(length + 1);
      GetWindowText(hwnd, text, text.Capacity);
      return text.ToString();
    }

    private static bool IsCloaked(IntPtr hwnd) {
      try { int value; return DwmGetWindowAttribute(hwnd, 14, out value, 4) == 0 && value != 0; }
      catch { return false; }
    }

    public static WindowTarget Find(string query) {
      try { SetProcessDPIAware(); } catch {}
      var matches = new List<WindowTarget>();
      EnumWindows(delegate(IntPtr hwnd, IntPtr state) {
        if (!IsWindowVisible(hwnd) || IsCloaked(hwnd)) return true;
        string title = TitleOf(hwnd);
        if (title.Length == 0 || title.IndexOf(query, StringComparison.OrdinalIgnoreCase) < 0) return true;
        Rect bounds;
        if (!GetWindowRect(hwnd, out bounds) || bounds.Right <= bounds.Left || bounds.Bottom <= bounds.Top) return true;
        uint processId;
        GetWindowThreadProcessId(hwnd, out processId);
        matches.Add(new WindowTarget { Handle = hwnd.ToInt64(), ProcessId = processId, Title = title });
        return true;
      }, IntPtr.Zero);

      var exact = matches.FindAll(delegate(WindowTarget item) {
        return string.Equals(item.Title, query, StringComparison.OrdinalIgnoreCase);
      });
      if (exact.Count == 1) return exact[0];
      if (exact.Count > 1 || matches.Count > 1) throw new InvalidOperationException("Multiple visible windows match that title; use a more specific title.");
      if (matches.Count == 0) throw new InvalidOperationException("No visible window matches that title.");
      return matches[0];
    }

    public static void Capture(long rawHandle, uint expectedProcessId, string path) {
      try { SetProcessDPIAware(); } catch {}
      var hwnd = new IntPtr(rawHandle);
      if (!IsWindow(hwnd) || !IsWindowVisible(hwnd) || IsCloaked(hwnd)) throw new InvalidOperationException("Selected window is no longer available.");
      uint processId;
      GetWindowThreadProcessId(hwnd, out processId);
      if (processId != expectedProcessId) throw new InvalidOperationException("Selected window changed before capture.");
      Rect bounds;
      if (!GetWindowRect(hwnd, out bounds)) throw new InvalidOperationException("Could not read selected window bounds.");
      int width = bounds.Right - bounds.Left;
      int height = bounds.Bottom - bounds.Top;
      long pixels = (long)width * height;
      if (width <= 0 || height <= 0 || width > 10000 || height > 10000 || pixels > 40000000) {
        throw new InvalidOperationException("Selected window dimensions are unsupported.");
      }

      using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
      using (var graphics = Graphics.FromImage(bitmap)) {
        IntPtr hdc = graphics.GetHdc();
        bool captured;
        try { captured = PrintWindow(hwnd, hdc, 2); }
        finally { graphics.ReleaseHdc(hdc); }
        if (!captured) throw new InvalidOperationException("Windows could not capture selected window.");
        bitmap.Save(path, ImageFormat.Png);
      }
    }
  }
}`;

function powershellScript(lines: string[]): string[] {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
    "Add-Type -AssemblyName System.Drawing",
    `$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(WINDOWS_NATIVE_SOURCE, "utf8").toString("base64")}'))`,
    "Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing",
    ...lines,
  ].join("\n");
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

export async function findWindow(
  exec: Exec,
  title: string,
  signal?: AbortSignal,
  platform: NodeJS.Platform = process.platform,
): Promise<WindowTarget> {
  if (platform !== "win32") throw new Error("Window capture currently supports Windows only");
  const query = title.trim();
  if (!query) throw new Error("Window capture requires a non-empty title");
  const encodedQuery = Buffer.from(query, "utf8").toString("base64");
  const result = await exec("powershell.exe", powershellScript([
    `$query = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedQuery}'))`,
    "[PiHelios.Native]::Find($query) | ConvertTo-Json -Compress",
  ]), { signal, timeout: 15_000 });
  if (result.code !== 0) throw failed("Window lookup", result);
  try {
    const target = JSON.parse(result.stdout.trim()) as { Handle?: unknown; ProcessId?: unknown; Title?: unknown };
    if (typeof target.Handle !== "number" || typeof target.ProcessId !== "number" || typeof target.Title !== "string") throw new Error();
    return { handle: target.Handle, processId: target.ProcessId, title: target.Title };
  } catch {
    throw new Error("Window lookup returned an invalid result");
  }
}

export async function captureWindow(
  exec: Exec,
  target: WindowTarget,
  outputPath: string,
  signal?: AbortSignal,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== "win32") throw new Error("Window capture currently supports Windows only");
  const encodedPath = Buffer.from(outputPath, "utf8").toString("base64");
  const result = await exec("powershell.exe", powershellScript([
    `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    `[PiHelios.Native]::Capture(${target.handle}, [uint32]${target.processId}, $path)`,
  ]), { signal, timeout: 15_000 });
  if (result.code !== 0) throw failed("Window capture", result);
  if (!await outputCreated(outputPath)) throw new Error("Window capture produced no screenshot file");
}
