// OS-level drag helper for manual QA (macOS, needs Accessibility permission
// for the terminal that runs it).
//
//   swift os-drag.swift locate <window title> <item name>
//     Prints {"x":…, "y":…} — the screen center of the Finder item named
//     <item name> in the Finder window titled <window title>.
//   swift os-drag.swift drag <x1> <y1> <x2> <y2>
//     Presses the left button at (x1, y1), moves to (x2, y2) in small steps,
//     hovers, and releases: a real drag session, as a user would do it.
//
// Coordinates are global display points, origin at the primary display's
// top-left corner — the same space as Electron's BrowserWindow bounds.

import ApplicationServices
import AppKit
import Foundation

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
	var value: AnyObject?
	return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func frame(_ element: AXUIElement) -> CGRect? {
	guard let position = attribute(element, kAXPositionAttribute), let size = attribute(element, kAXSizeAttribute) else { return nil }
	var point = CGPoint.zero
	var extent = CGSize.zero
	AXValueGetValue(position as! AXValue, .cgPoint, &point)
	AXValueGetValue(size as! AXValue, .cgSize, &extent)
	return CGRect(origin: point, size: extent)
}

func names(_ element: AXUIElement) -> [String] {
	[kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute, kAXFilenameAttribute].compactMap { attribute(element, $0) as? String }
}

/// Depth-first search for the item; prefers the icon image over its label.
func find(_ element: AXUIElement, _ item: String, _ depth: Int = 0) -> (role: String, rect: CGRect)? {
	if depth > 14 { return nil }
	var best: (role: String, rect: CGRect)?
	let role = attribute(element, kAXRoleAttribute) as? String ?? ""
	if names(element).contains(item), let rect = frame(element), rect.width > 0 {
		best = (role, rect)
		if role == kAXImageRole as String { return best }
	}
	for child in attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
		if let hit = find(child, item, depth + 1) {
			if hit.role == kAXImageRole as String { return hit }
			best = best ?? hit
		}
	}
	return best
}

func post(_ type: CGEventType, _ point: CGPoint) {
	CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)!.post(tap: .cghidEventTap)
}

let args = CommandLine.arguments
guard AXIsProcessTrusted() else {
	FileHandle.standardError.write("Accessibility permission is required\n".data(using: .utf8)!)
	exit(2)
}
switch args.count > 1 ? args[1] : "" {
case "locate" where args.count == 4:
	guard let finder = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first else { exit(3) }
	let app = AXUIElementCreateApplication(finder.processIdentifier)
	let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
	guard let window = windows.first(where: { (attribute($0, kAXTitleAttribute) as? String) == args[2] }) else {
		FileHandle.standardError.write("no Finder window titled \(args[2])\n".data(using: .utf8)!)
		exit(4)
	}
	guard let hit = find(window, args[3]) else {
		FileHandle.standardError.write("no item \(args[3])\n".data(using: .utf8)!)
		exit(5)
	}
	print("{\"x\":\(hit.rect.midX),\"y\":\(hit.rect.midY),\"role\":\"\(hit.role)\"}")
case "drag" where args.count == 6:
	let from = CGPoint(x: Double(args[2])!, y: Double(args[3])!)
	let to = CGPoint(x: Double(args[4])!, y: Double(args[5])!)
	post(.mouseMoved, from)
	usleep(150_000)
	post(.leftMouseDown, from)
	usleep(250_000)
	let steps = 40
	for step in 1...steps {
		let t = Double(step) / Double(steps)
		post(.leftMouseDragged, CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t))
		usleep(25_000)
	}
	// Hover so the target sees dragover before the drop.
	for _ in 0..<10 {
		post(.leftMouseDragged, to)
		usleep(50_000)
	}
	post(.leftMouseUp, to)
	usleep(300_000)
	print("{\"dropped\":true}")
default:
	FileHandle.standardError.write("usage: locate <window> <item> | drag <x1> <y1> <x2> <y2>\n".data(using: .utf8)!)
	exit(1)
}
