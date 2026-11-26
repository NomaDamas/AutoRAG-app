// macOS AppleEvent `misc`/`mvis` (kAERevealSelection) native N-API addon.
//
// Electron exposes `app.on("open-file")` for `aevt`/`odoc` (Open Document / Folder),
// but does not surface `misc`/`mvis` ("Reveal in Finder" / NSWorkspace
// activateFileViewerSelectingURLs: when NSFileViewer points at this app).
//
// Installing this handler lets Dazzi receive reveal requests from Chrome,
// VS Code, Slack, Safari, and any Cocoa app that honors NSFileViewer, opening
// the target file selected inside Dazzi.
//
// Build (macOS arm64, N-API ABI-stable across Node/Electron versions):
//   node scripts/build-mac-reveal-hook.mjs

#include <node_api.h>
#import <Cocoa/Cocoa.h>
#import <Carbon/Carbon.h>
#include <cstdlib>
#include <cstring>

static napi_threadsafe_function g_tsfn = nullptr;

@interface DazziRevealEventHandler : NSObject
- (void)handleRevealEvent:(NSAppleEventDescriptor *)event withReplyEvent:(NSAppleEventDescriptor *)reply;
@end

@implementation DazziRevealEventHandler
- (void)handleRevealEvent:(NSAppleEventDescriptor *)event withReplyEvent:(NSAppleEventDescriptor *)reply {
    (void)reply;
    if (g_tsfn == nullptr) return;
    NSAppleEventDescriptor *direct = [event paramDescriptorForKeyword:keyDirectObject];
    if (direct == nil) return;

    NSMutableArray<NSString *> *paths = [NSMutableArray array];
    NSInteger count = [direct numberOfItems];
    if (count > 0) {
        for (NSInteger i = 1; i <= count; i++) {
            NSAppleEventDescriptor *item = [direct descriptorAtIndex:i];
            NSAppleEventDescriptor *urlDesc = [item coerceToDescriptorType:typeFileURL];
            if (urlDesc != nil) {
                NSString *urlString = [[NSString alloc] initWithData:[urlDesc data] encoding:NSUTF8StringEncoding];
                NSURL *url = urlString ? [NSURL URLWithString:urlString] : nil;
                if (url != nil && url.fileURL && url.path.length > 0) {
                    [paths addObject:url.path];
                }
            }
        }
    } else {
        NSAppleEventDescriptor *urlDesc = [direct coerceToDescriptorType:typeFileURL];
        if (urlDesc != nil) {
            NSString *urlString = [[NSString alloc] initWithData:[urlDesc data] encoding:NSUTF8StringEncoding];
            NSURL *url = urlString ? [NSURL URLWithString:urlString] : nil;
            if (url != nil && url.fileURL && url.path.length > 0) {
                [paths addObject:url.path];
            }
        }
    }

    if (paths.count == 0) return;
    NSError *err = nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:paths options:0 error:&err];
    if (json == nil || err != nil) return;

    char *copy = static_cast<char *>(std::malloc(json.length + 1));
    if (copy == nullptr) return;
    std::memcpy(copy, json.bytes, json.length);
    copy[json.length] = '\0';
    if (napi_call_threadsafe_function(g_tsfn, copy, napi_tsfn_nonblocking) != napi_ok) {
        std::free(copy);
    }
}
@end

static DazziRevealEventHandler *g_handler = nil;

static void dispatchToJs(napi_env env, napi_value jsCallback, void *context, void *data) {
    (void)context;
    char *json = static_cast<char *>(data);
    if (env != nullptr && jsCallback != nullptr && json != nullptr) {
        napi_value arg = nullptr;
        napi_value undef = nullptr;
        if (napi_create_string_utf8(env, json, NAPI_AUTO_LENGTH, &arg) == napi_ok &&
            napi_get_undefined(env, &undef) == napi_ok) {
            napi_call_function(env, undef, jsCallback, 1, &arg, nullptr);
        }
    }
    std::free(json);
}

static napi_value Install(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1] = { nullptr };
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1) {
        napi_throw_type_error(env, nullptr, "Expected callback function");
        return nullptr;
    }

    if (g_tsfn != nullptr) {
        napi_release_threadsafe_function(g_tsfn, napi_tsfn_abort);
        g_tsfn = nullptr;
    }

    napi_value resourceName = nullptr;
    napi_create_string_utf8(env, "dazzi_mac_reveal_ae", NAPI_AUTO_LENGTH, &resourceName);
    if (napi_create_threadsafe_function(
            env,
            argv[0],
            nullptr,
            resourceName,
            0,
            1,
            nullptr,
            nullptr,
            nullptr,
            dispatchToJs,
            &g_tsfn) != napi_ok) {
        napi_throw_error(env, nullptr, "Failed to create threadsafe function");
        return nullptr;
    }
    napi_unref_threadsafe_function(env, g_tsfn);

    if (g_handler == nil) {
        g_handler = [[DazziRevealEventHandler alloc] init];
    }

    [[NSAppleEventManager sharedAppleEventManager]
        setEventHandler:g_handler
            andSelector:@selector(handleRevealEvent:withReplyEvent:)
          forEventClass:kAEMiscStandards
             andEventID:kAEMakeObjectsVisible];
    [[NSAppleEventManager sharedAppleEventManager]
        setEventHandler:g_handler
            andSelector:@selector(handleRevealEvent:withReplyEvent:)
          forEventClass:kAEMiscStandards
             andEventID:kAERevealSelection];

    napi_value result = nullptr;
    napi_get_boolean(env, true, &result);
    return result;
}

static napi_value Uninstall(napi_env env, napi_callback_info info) {
    (void)info;
    if (g_handler != nil) {
        [[NSAppleEventManager sharedAppleEventManager]
            removeEventHandlerForEventClass:kAEMiscStandards
                                 andEventID:kAEMakeObjectsVisible];
        [[NSAppleEventManager sharedAppleEventManager]
            removeEventHandlerForEventClass:kAEMiscStandards
                                 andEventID:kAERevealSelection];
    }
    if (g_tsfn != nullptr) {
        napi_release_threadsafe_function(g_tsfn, napi_tsfn_abort);
        g_tsfn = nullptr;
    }
    napi_value result = nullptr;
    napi_get_boolean(env, true, &result);
    return result;
}

static napi_value Init(napi_env env, napi_value exports) {
    napi_value installFn = nullptr;
    napi_value uninstallFn = nullptr;
    napi_create_function(env, "install", NAPI_AUTO_LENGTH, Install, nullptr, &installFn);
    napi_create_function(env, "uninstall", NAPI_AUTO_LENGTH, Uninstall, nullptr, &uninstallFn);
    napi_set_named_property(env, exports, "install", installFn);
    napi_set_named_property(env, exports, "uninstall", uninstallFn);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
