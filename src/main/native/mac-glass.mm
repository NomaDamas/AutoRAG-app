// macOS material for the quick-search launcher: Liquid Glass behind the page.
//
// Electron's `vibrancy` option fills the window's rectangle and can only round it to the system's ~10pt, and it has no
// way to ask for macOS 26's glass. This addon puts the material in itself, behind the web content:
//   - macOS 26+: an `NSGlassEffectView` (looked up by name, so it compiles on any SDK) with the palette's corner radius;
//   - earlier:   an `NSVisualEffectView` (behind-window blur) masked to the same rounded rectangle.
// `attach(handle, cornerRadius)` returns "glass" or "vibrancy"; the JS side decides what the page draws from that.
//
// Build (macOS): node scripts/build-mac-glass.mjs  (Node's N-API headers + Apple Clang + Cocoa; ABI-stable across Electron).

#include <node_api.h>
#import <Cocoa/Cocoa.h>

static NSString *const kGlassTag = @"dev.dazzi.quick-search.material";

static NSImage *roundedMask(CGFloat radius) {
    CGFloat edge = radius * 2 + 1;
    NSImage *mask = [NSImage imageWithSize:NSMakeSize(edge, edge) flipped:NO drawingHandler:^BOOL(NSRect rect) {
        [[NSColor blackColor] set];
        [[NSBezierPath bezierPathWithRoundedRect:rect xRadius:radius yRadius:radius] fill];
        return YES;
    }];
    mask.capInsets = NSEdgeInsetsMake(radius, radius, radius, radius);
    mask.resizingMode = NSImageResizingModeStretch;
    return mask;
}

static void removeOurs(NSView *host) {
    for (NSView *sub in [host.subviews copy]) {
        if ([sub.identifier isEqualToString:kGlassTag]) [sub removeFromSuperview];
    }
}

static napi_value Attach(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2] = { nullptr, nullptr };
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 2) {
        napi_throw_type_error(env, nullptr, "Expected (handle: Buffer, cornerRadius: number)");
        return nullptr;
    }
    void *data = nullptr;
    size_t length = 0;
    if (napi_get_buffer_info(env, argv[0], &data, &length) != napi_ok || data == nullptr || length < sizeof(void *)) {
        napi_throw_type_error(env, nullptr, "handle must be a native window handle Buffer");
        return nullptr;
    }
    double radius = 26;
    napi_get_value_double(env, argv[1], &radius);

    void *raw = *static_cast<void **>(data);
    NSView *host = (__bridge NSView *)raw;
    if (host == nil || ![host isKindOfClass:[NSView class]]) {
        napi_throw_error(env, nullptr, "native handle is not an NSView");
        return nullptr;
    }

    removeOurs(host);
    const char *kind = "vibrancy";
    NSView *material = nil;
    Class glassClass = NSClassFromString(@"NSGlassEffectView");
    if (glassClass != nil) {
        material = [[glassClass alloc] initWithFrame:host.bounds];
        // Properties set by key so no macOS 26 header is needed; a build against an older SDK still links.
        @try {
            [material setValue:@(radius) forKey:@"cornerRadius"];
            kind = "glass";
        } @catch (NSException *) {
            material = nil;
        }
    }
    if (material == nil) {
        NSVisualEffectView *blur = [[NSVisualEffectView alloc] initWithFrame:host.bounds];
        blur.material = NSVisualEffectMaterialUnderWindowBackground;
        blur.blendingMode = NSVisualEffectBlendingModeBehindWindow;
        blur.state = NSVisualEffectStateActive;
        blur.maskImage = roundedMask((CGFloat)radius);
        material = blur;
        kind = "vibrancy";
    }
    material.identifier = kGlassTag;
    material.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    // Behind everything the content view holds, so the transparent page draws over the material (Electron's own vibrancy does the same).
    [host addSubview:material positioned:NSWindowBelow relativeTo:nil];
    [host.window invalidateShadow];

    napi_value result = nullptr;
    napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &result);
    return result;
}

static napi_value Init(napi_env env, napi_value exports) {
    napi_value attachFn = nullptr;
    napi_create_function(env, "attach", NAPI_AUTO_LENGTH, Attach, nullptr, &attachFn);
    napi_set_named_property(env, exports, "attach", attachFn);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
