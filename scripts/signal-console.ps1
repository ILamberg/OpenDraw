param(
    [Parameter(Mandatory = $true)]
    [int]$TargetPid
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($TargetPid -le 0) {
    throw 'TargetPid must be a positive process id.'
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class OpenDrawConsoleSignal
{
    private const uint CTRL_C_EVENT = 0;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(IntPtr handlerRoutine, bool add);

    public static void SendCtrlC(int processId)
    {
        // This helper is a disposable child process. Detach it from the new launcher
        // before attaching to the old OpenDraw console so Ctrl+C cannot hit the new
        // launcher. Ignore Ctrl+C inside the helper itself while broadcasting it to
        // the target console.
        FreeConsole();
        if (!AttachConsole((uint)processId))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to attach to the existing OpenDraw console");

        try
        {
            if (!SetConsoleCtrlHandler(IntPtr.Zero, true))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to protect restart helper from Ctrl+C");

            if (!GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to send Ctrl+C to the existing OpenDraw console");

            // Give Windows a moment to dispatch the control event before detaching.
            System.Threading.Thread.Sleep(350);
        }
        finally
        {
            FreeConsole();
        }
    }
}
'@

[OpenDrawConsoleSignal]::SendCtrlC($TargetPid)
