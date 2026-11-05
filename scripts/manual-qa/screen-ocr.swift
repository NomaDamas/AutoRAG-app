// Prints the text macOS Vision reads in an image, one line per observation: `swift screen-ocr.swift <png>`.
// The Raycast lane reads Raycast's window with it, because Raycast's list exposes no text to Accessibility.
import Foundation
import Vision
import AppKit
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = NSImage(contentsOf: url), let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(1) }
let request = VNRecognizeTextRequest()
request.recognitionLanguages = ["ko-KR", "en-US"]
request.recognitionLevel = .accurate
try VNImageRequestHandler(cgImage: cg).perform([request])
for observation in request.results ?? [] { if let text = observation.topCandidates(1).first?.string { print(text) } }
