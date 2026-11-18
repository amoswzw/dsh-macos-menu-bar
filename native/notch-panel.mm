#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <QuartzCore/QuartzCore.h>

// Use the stable Node-API C ABI. Declaring the small surface used here keeps
// Desktop installs independent of a system Node.js header installation.
typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef struct napi_callback_info__* napi_callback_info;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
extern "C" int napi_get_cb_info(napi_env, napi_callback_info, size_t*, napi_value*, napi_value*, void**);
extern "C" int napi_get_value_bool(napi_env, napi_value, bool*);
extern "C" int napi_get_value_int32(napi_env, napi_value, int32_t*);
extern "C" int napi_get_value_string_utf8(napi_env, napi_value, char*, size_t, size_t*);
extern "C" int napi_get_array_length(napi_env, napi_value, uint32_t*);
extern "C" int napi_get_element(napi_env, napi_value, uint32_t, napi_value*);
extern "C" int napi_create_function(napi_env, const char*, size_t, napi_callback, void*, napi_value*);
extern "C" int napi_set_named_property(napi_env, napi_value, const char*, napi_value);
extern "C" int napi_create_object(napi_env, napi_value*);
extern "C" int napi_create_double(napi_env, double, napi_value*);
extern "C" int napi_create_int32(napi_env, int32_t, napi_value*);
extern "C" int napi_get_undefined(napi_env, napi_value*);
#include <deque>

static NSPanel* islandPanel = nil;
static NSPanel* approvalPanel = nil;
static int activeApprovalId = -1;
static std::deque<std::pair<int, int>> approvalEvents;
static bool approvalCompact = false;
static NSTextField* approvalHeading = nil;
static NSString* approvalBaseTitle = nil;
static NSString* approvalFullDetail = nil;
static NSView* approvalCompactContent = nil;
static NSScrollView* approvalDetailScroll = nil;
static NSTimer* approvalHoverTimer = nil;
static NSRect approvalCompactFrame = NSZeroRect;
static CGFloat approvalExpandedHeight = 0;
static NSTimeInterval approvalHoverLastInside = 0;
static NSView* indicatorDot = nil;
static NSImageView* brandIcon = nil;
static NSString* brandIconPath = nil;
static int indicatorState = 0;

static NSScreen* internalScreen() {
  for (NSScreen* screen in [NSScreen screens]) {
    NSNumber* value = screen.deviceDescription[@"NSScreenNumber"];
    if (value && CGDisplayIsBuiltin((CGDirectDisplayID)value.unsignedIntValue)) return screen;
  }
  return nil;
}

static bool hasCutout(NSScreen* screen) {
  if (!screen) return false;
  if ([screen respondsToSelector:@selector(safeAreaInsets)] && screen.safeAreaInsets.top > 0) return true;
  if (![screen respondsToSelector:@selector(auxiliaryTopLeftArea)]
      || ![screen respondsToSelector:@selector(auxiliaryTopRightArea)]) return false;
  NSRect left = screen.auxiliaryTopLeftArea, right = screen.auxiliaryTopRightArea;
  return NSWidth(left) > 0 && NSWidth(right) > 0 && NSMinX(right) > NSMaxX(left);
}

static CGFloat cutoutHeight(NSScreen* screen) {
  if (!hasCutout(screen)) return 0;
  CGFloat safe = [screen respondsToSelector:@selector(safeAreaInsets)] ? screen.safeAreaInsets.top : 0;
  return safe > 0 ? safe : MAX(24, NSMaxY(screen.frame) - NSMaxY(screen.visibleFrame));
}

static CGFloat cutoutWidth(NSScreen* screen) {
  if (!hasCutout(screen)) return 0;
  if (![screen respondsToSelector:@selector(auxiliaryTopLeftArea)]
      || ![screen respondsToSelector:@selector(auxiliaryTopRightArea)]) return 180;
  NSRect left = screen.auxiliaryTopLeftArea;
  NSRect right = screen.auxiliaryTopRightArea;
  CGFloat width = NSMinX(right) - NSMaxX(left);
  return width > 0 ? width : 180;
}

static NSRect islandRect(NSScreen* screen) {
  NSRect bounds = screen.frame;
  CGFloat width = MIN(MAX(cutoutWidth(screen) + 76, 240), MIN(400, NSWidth(bounds) - 24));
  CGFloat height = hasCutout(screen) ? MAX(24, cutoutHeight(screen)) : 42;
  CGFloat top = hasCutout(screen) ? NSMaxY(bounds) : NSMaxY(screen.visibleFrame) - 4;
  return NSMakeRect(NSMidX(bounds) - width / 2, top - height, width, height);
}

static void settleApproval(int choice) {
  if (!approvalPanel) return;
  [approvalHoverTimer invalidate];
  approvalHoverTimer = nil;
  NSPanel* panel = approvalPanel;
  approvalPanel = nil;
  approvalCompact = false;
  approvalHeading = nil;
  approvalBaseTitle = nil;
  approvalFullDetail = nil;
  approvalCompactContent = nil;
  approvalDetailScroll = nil;
  approvalCompactFrame = NSZeroRect;
  approvalExpandedHeight = 0;
  approvalHoverLastInside = 0;
  [panel orderOut:nil];
  [panel close];
  approvalEvents.emplace_back(activeApprovalId, choice);
  activeApprovalId = -1;
}

@interface DSHNativePanel : NSPanel
@end
@implementation DSHNativePanel
- (BOOL)canBecomeKeyWindow { return YES; }
- (BOOL)canBecomeMainWindow { return YES; }
@end

@interface DSHIslandSurface : NSView
@property(nonatomic) BOOL attached;
@end
@implementation DSHIslandSurface
- (void)drawRect:(NSRect)dirtyRect {
  NSRect bounds = self.bounds;
  NSBezierPath* shape = [NSBezierPath bezierPath];
  CGFloat r = MIN(24, NSHeight(bounds) / 2);
  if (self.attached) {
    [shape moveToPoint:NSMakePoint(0, NSMaxY(bounds))];
    [shape lineToPoint:NSMakePoint(NSMaxX(bounds), NSMaxY(bounds))];
    [shape lineToPoint:NSMakePoint(NSMaxX(bounds), r)];
    [shape curveToPoint:NSMakePoint(NSMaxX(bounds) - r, 0)
        controlPoint1:NSMakePoint(NSMaxX(bounds), 0)
        controlPoint2:NSMakePoint(NSMaxX(bounds) - r, 0)];
    [shape lineToPoint:NSMakePoint(r, 0)];
    [shape curveToPoint:NSMakePoint(0, r)
        controlPoint1:NSMakePoint(0, 0)
        controlPoint2:NSMakePoint(0, r)];
    [shape closePath];
  } else {
    shape = [NSBezierPath bezierPathWithRoundedRect:bounds xRadius:r yRadius:r];
  }
  [[NSColor colorWithCalibratedRed:0.025 green:0.025 blue:0.035 alpha:0.98] setFill];
  [shape fill];
}
@end

@interface DSHPanelActions : NSObject
- (void)approvalPressed:(id)sender;
@end
@implementation DSHPanelActions
- (void)approvalPressed:(NSButton*)sender { settleApproval((int)sender.tag); }
@end
static DSHPanelActions* actions = nil;

static NSTextField* label(NSString* text, NSRect frame, CGFloat size, BOOL bold) {
  NSTextField* field = [NSTextField labelWithString:text ?: @""];
  field.frame = frame;
  field.textColor = [NSColor whiteColor];
  field.font = bold ? [NSFont boldSystemFontOfSize:size] : [NSFont systemFontOfSize:size];
  field.backgroundColor = [NSColor clearColor];
  field.drawsBackground = NO;
  field.lineBreakMode = NSLineBreakByTruncatingTail;
  return field;
}

static NSButton* button(NSString* text, NSRect frame, NSInteger tag, BOOL primary, SEL action) {
  NSButton* control = [[NSButton alloc] initWithFrame:frame];
  control.title = text ?: @"";
  control.tag = tag;
  control.bordered = NO;
  control.focusRingType = NSFocusRingTypeNone;
  control.wantsLayer = YES;
  control.layer.cornerRadius = 10;
  control.layer.backgroundColor = (primary ? [NSColor colorWithCalibratedRed:0.11 green:0.42 blue:0.87 alpha:1]
    : [NSColor colorWithCalibratedWhite:0.24 alpha:1]).CGColor;
  control.contentTintColor = [NSColor whiteColor];
  control.font = [NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
  control.target = actions;
  control.action = action;
  return control;
}

static void paintIndicator() {
  if (!indicatorDot) return;
  [indicatorDot.layer removeAnimationForKey:@"activity"];
  [brandIcon.layer removeAnimationForKey:@"swim"];
  indicatorDot.layer.opacity = 1;
  indicatorDot.layer.backgroundColor = (indicatorState == 2 ? [NSColor systemOrangeColor]
    : indicatorState == 1 ? [NSColor systemBlueColor]
    : [NSColor colorWithCalibratedWhite:0.55 alpha:1]).CGColor;
  if (indicatorState == 0) return;
  CABasicAnimation* pulse = [CABasicAnimation animationWithKeyPath:@"opacity"];
  pulse.fromValue = @0.35;
  pulse.toValue = @1;
  pulse.duration = indicatorState == 2 ? 0.55 : 0.9;
  pulse.autoreverses = YES;
  pulse.repeatCount = HUGE_VALF;
  [indicatorDot.layer addAnimation:pulse forKey:@"activity"];
  if (brandIcon) {
    CABasicAnimation* swim = [CABasicAnimation animationWithKeyPath:@"transform.scale"];
    swim.fromValue = @0.91;
    swim.toValue = @1.07;
    swim.duration = indicatorState == 2 ? 0.65 : 1.1;
    swim.autoreverses = YES;
    swim.repeatCount = HUGE_VALF;
    [brandIcon.layer addAnimation:swim forKey:@"swim"];
  }
}

static NSPanel* makePanel(NSRect rect) {
  NSPanel* panel = [[DSHNativePanel alloc] initWithContentRect:rect
    styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
    backing:NSBackingStoreBuffered defer:NO];
  panel.releasedWhenClosed = NO;
  panel.level = NSStatusWindowLevel;
  panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces
    | NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorFullScreenAuxiliary;
  panel.opaque = NO;
  panel.backgroundColor = [NSColor clearColor];
  panel.hasShadow = NO;
  panel.hidesOnDeactivate = NO;
  panel.movable = NO;
  return panel;
}

static void setApprovalExpanded(bool expanded) {
  if (!approvalPanel || !approvalCompact || !approvalCompactContent || !approvalDetailScroll) return;
  CGFloat compactHeight = NSHeight(approvalCompactFrame);
  CGFloat height = expanded ? approvalExpandedHeight : compactHeight;
  if (fabs(NSHeight(approvalPanel.frame) - height) < 0.5) return;
  NSRect frame = approvalCompactFrame;
  frame.origin.y = NSMaxY(approvalCompactFrame) - height;
  frame.size.height = height;
  [approvalPanel setFrame:frame display:YES];
  BOOL attached = ((DSHIslandSurface*)approvalPanel.contentView).attached;
  DSHIslandSurface* root = [[DSHIslandSurface alloc] initWithFrame:NSMakeRect(0, 0, NSWidth(frame), height)];
  root.attached = attached;
  root.wantsLayer = YES;
  [approvalCompactContent removeFromSuperview];
  [approvalDetailScroll removeFromSuperview];
  approvalCompactContent.frame = NSMakeRect(0, height - compactHeight, NSWidth(frame), compactHeight);
  approvalDetailScroll.frame = NSMakeRect(18, 14, NSWidth(frame) - 36, height - compactHeight - 22);
  approvalDetailScroll.hidden = !expanded;
  [root addSubview:approvalCompactContent];
  [root addSubview:approvalDetailScroll];
  approvalPanel.contentView = root;
  approvalPanel.hasShadow = expanded;
}

static void pollApprovalHover() {
  if (!approvalPanel || !approvalCompact) return;
  if (NSPointInRect([NSEvent mouseLocation], approvalPanel.frame)) {
    approvalHoverLastInside = [NSDate timeIntervalSinceReferenceDate];
    setApprovalExpanded(true);
  } else if ([NSDate timeIntervalSinceReferenceDate] - approvalHoverLastInside > 0.25) {
    setApprovalExpanded(false);
  }
}

static void renderIsland() {
  NSScreen* screen = internalScreen();
  if (!screen || !islandPanel) return;
  NSRect rect = islandRect(screen);
  [islandPanel setFrame:rect display:YES];
  DSHIslandSurface* root = [[DSHIslandSurface alloc] initWithFrame:NSMakeRect(0, 0, NSWidth(rect), NSHeight(rect))];
  root.attached = hasCutout(screen);
  root.wantsLayer = YES;
  CGFloat width = NSWidth(rect), height = NSHeight(rect);
  NSImage* icon = brandIconPath ? [[NSImage alloc] initWithContentsOfFile:brandIconPath] : nil;
  if (icon) {
    brandIcon = [[NSImageView alloc] initWithFrame:NSMakeRect(8, (height - 24) / 2, 24, 24)];
    brandIcon.image = icon;
    brandIcon.imageScaling = NSImageScaleProportionallyUpOrDown;
    brandIcon.wantsLayer = YES;
    brandIcon.layer.cornerRadius = 6;
    brandIcon.layer.masksToBounds = YES;
    [root addSubview:brandIcon];
  } else {
    brandIcon = nil;
    [root addSubview:label(@"D", NSMakeRect(12, (height - 20) / 2, 20, 20), 13, YES)];
  }
  NSView* dot = [[NSView alloc] initWithFrame:NSMakeRect(width - 24, (height - 7) / 2, 7, 7)];
  dot.wantsLayer = YES;
  dot.layer.backgroundColor = [NSColor systemBlueColor].CGColor;
  dot.layer.cornerRadius = 3.5;
  [root addSubview:dot];
  indicatorDot = dot;
  paintIndicator();
  islandPanel.contentView = root;
  [islandPanel orderFrontRegardless];
}

static NSString* stringValue(napi_env env, napi_value value) {
  size_t size = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &size) != 0 || size > 5000) return @"";
  char* bytes = (char*)malloc(size + 1);
  napi_get_value_string_utf8(env, value, bytes, size + 1, &size);
  NSString* result = [[NSString alloc] initWithBytes:bytes length:size encoding:NSUTF8StringEncoding] ?: @"";
  free(bytes);
  return result;
}

static void setNumber(napi_env env, napi_value object, const char* key, double number) {
  napi_value value;
  napi_create_double(env, number, &value);
  napi_set_named_property(env, object, key, value);
}

static napi_value metrics(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_create_object(env, &result);
  NSScreen* screen = internalScreen();
  setNumber(env, result, "available", screen ? 1 : 0);
  if (screen) {
    NSRect rect = islandPanel ? islandPanel.frame : islandRect(screen);
    setNumber(env, result, "notched", hasCutout(screen) ? 1 : 0);
    setNumber(env, result, "safeTop", cutoutHeight(screen));
    setNumber(env, result, "cutoutWidth", cutoutWidth(screen));
    setNumber(env, result, "x", NSMinX(rect));
    setNumber(env, result, "y", NSMaxY(screen.frame) - NSMaxY(rect));
    setNumber(env, result, "width", NSWidth(rect));
    setNumber(env, result, "height", NSHeight(rect));
  }
  return result;
}

static napi_value showIsland(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1];
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  brandIconPath = count == 1 ? stringValue(env, args[0]) : nil;
  NSScreen* screen = internalScreen();
  if (!screen) return metrics(env, info);
  if (!actions) actions = [[DSHPanelActions alloc] init];
  if (!islandPanel) islandPanel = makePanel(islandRect(screen));
  renderIsland();
  return metrics(env, info);
}

static napi_value hideIsland(napi_env env, napi_callback_info info) {
  if (islandPanel) { [islandPanel orderOut:nil]; [islandPanel close]; islandPanel = nil; }
  indicatorDot = nil;
  brandIcon = nil;
  return metrics(env, info);
}

static napi_value setIndicator(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; int32_t state = 0;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count == 1) napi_get_value_int32(env, args[0], &state);
  indicatorState = state >= 0 && state <= 2 ? state : 0;
  paintIndicator();
  return metrics(env, info);
}

static napi_value showApproval(napi_env env, napi_callback_info info) {
  size_t count = 6; napi_value args[6];
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 6) return metrics(env, info);
  if (approvalPanel) settleApproval(0);
  NSScreen* screen = internalScreen();
  if (!screen) return metrics(env, info);
  napi_get_value_int32(env, args[4], &activeApprovalId);
  napi_get_value_bool(env, args[5], &approvalCompact);
  if (!actions) actions = [[DSHPanelActions alloc] init];
  uint32_t countButtons = 0;
  napi_get_array_length(env, args[2], &countButtons);
  countButtons = MIN(MAX(countButtons, 2), 3);
  NSRect screenFrame = screen.frame;
  CGFloat notch = hasCutout(screen) ? cutoutWidth(screen) : 0;
  CGFloat widestButton = 0;
  if (approvalCompact) {
    NSFont* buttonFont = [NSFont systemFontOfSize:11 weight:NSFontWeightMedium];
    for (uint32_t index = 0; index < countButtons; index++) {
      napi_value value;
      napi_get_element(env, args[2], index, &value);
      CGFloat textWidth = [stringValue(env, value) sizeWithAttributes:@{NSFontAttributeName: buttonFont}].width;
      widestButton = MAX(widestButton, ceil(textWidth) + 16);
    }
  }
  CGFloat requiredWing = 14 + 5 * (countButtons - 1) + countButtons * widestButton;
  CGFloat width = approvalCompact ? MIN(MAX(560, notch + MAX(440, 2 * requiredWing)), NSWidth(screenFrame) - 24)
    : MIN(460, NSWidth(screenFrame) - 24);
  CGFloat height = approvalCompact ? (hasCutout(screen) ? cutoutHeight(screen)
    : MAX(24, NSMaxY(screenFrame) - NSMaxY(screen.visibleFrame)))
    : (hasCutout(screen) ? 242 : 204);
  CGFloat top = approvalCompact || hasCutout(screen) ? NSMaxY(screenFrame)
    : NSMaxY(screen.visibleFrame) - 4;
  NSRect rect = NSMakeRect(NSMidX(screenFrame) - width / 2, top - height, width, height);
  approvalPanel = makePanel(rect);
  approvalPanel.level = NSPopUpMenuWindowLevel;
  DSHIslandSurface* root = [[DSHIslandSurface alloc] initWithFrame:NSMakeRect(0, 0, width, height)];
  root.attached = hasCutout(screen);
  root.wantsLayer = YES;
  approvalBaseTitle = stringValue(env, args[0]);
  approvalFullDetail = stringValue(env, args[1]);
  NSView* controls = root;
  if (approvalCompact) {
    approvalCompactFrame = rect;
    approvalCompactContent = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, width, height)];
    [root addSubview:approvalCompactContent];
    controls = approvalCompactContent;
    NSFont* textFont = [NSFont systemFontOfSize:13];
    NSRect measured = [approvalFullDetail boundingRectWithSize:NSMakeSize(width - 48, CGFLOAT_MAX)
      options:NSStringDrawingUsesLineFragmentOrigin | NSStringDrawingUsesFontLeading
      attributes:@{NSFontAttributeName: textFont}];
    CGFloat detailHeight = MIN(MAX(120, ceil(NSHeight(measured)) + 34), MIN(320, NSHeight(screenFrame) / 3));
    approvalExpandedHeight = height + detailHeight;
    approvalDetailScroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(18, 14, width - 36, detailHeight - 22)];
    approvalDetailScroll.drawsBackground = NO;
    approvalDetailScroll.hasVerticalScroller = YES;
    approvalDetailScroll.borderType = NSNoBorder;
    NSTextView* detail = [[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, width - 36, detailHeight - 22)];
    detail.string = approvalFullDetail;
    detail.font = textFont;
    detail.textColor = [NSColor whiteColor];
    detail.drawsBackground = NO;
    detail.editable = NO;
    detail.selectable = YES;
    detail.textContainerInset = NSMakeSize(0, 4);
    detail.textContainer.widthTracksTextView = YES;
    approvalDetailScroll.documentView = detail;
    approvalDetailScroll.hidden = YES;
    [root addSubview:approvalDetailScroll];
  }
  CGFloat buttonWidth, buttonX, buttonY, buttonHeight, buttonGap;
  if (approvalCompact) {
    CGFloat wing = (width - notch) / 2;
    approvalHeading = label(approvalBaseTitle, NSMakeRect(12,
      height >= 32 ? height - 18 : (height - 16) / 2, wing - 20, 16), 11, YES);
    approvalHeading.toolTip = approvalBaseTitle;
    [controls addSubview:approvalHeading];
    if (height >= 32) {
      NSString* firstLine = [approvalFullDetail componentsSeparatedByString:@"\n"].firstObject;
      NSTextField* summary = label(firstLine, NSMakeRect(12, 3, wing - 20, 14), 10, NO);
      [controls addSubview:summary];
    }
    buttonGap = 5;
    buttonX = wing + notch + 7;
    buttonWidth = (wing - 14 - buttonGap * (countButtons - 1)) / countButtons;
    buttonHeight = MIN(26, height - 6);
    buttonY = (height - buttonHeight) / 2;
  } else {
    CGFloat topPadding = root.attached ? cutoutHeight(screen) + 16 : 16;
    approvalHeading = label(approvalBaseTitle, NSMakeRect(20, height - topPadding - 23, width - 40, 23), 15, YES);
    [controls addSubview:approvalHeading];
    NSTextField* message = label(stringValue(env, args[1]), NSMakeRect(20, 67, width - 40, height - topPadding - 94), 13, NO);
    message.lineBreakMode = NSLineBreakByWordWrapping;
    message.maximumNumberOfLines = 4;
    message.toolTip = message.stringValue;
    [controls addSubview:message];
    buttonGap = 8;
    buttonX = 20;
    buttonWidth = (width - 40 - buttonGap * (countButtons - 1)) / countButtons;
    buttonHeight = 36;
    buttonY = 18;
  }
  for (uint32_t index = 0; index < countButtons; index++) {
    napi_value value;
    napi_get_element(env, args[2], index, &value);
    NSString* title = stringValue(env, value);
    NSButton* control = button(title, NSMakeRect(buttonX + (buttonWidth + buttonGap) * index,
      buttonY, buttonWidth, buttonHeight), index, index == countButtons - 1, @selector(approvalPressed:));
    if (approvalCompact) {
      CGFloat fontSize = 11;
      while (fontSize > 9 && [title sizeWithAttributes:@{NSFontAttributeName:
        [NSFont systemFontOfSize:fontSize weight:NSFontWeightMedium]}].width > buttonWidth - 12) fontSize -= 0.5;
      control.font = [NSFont systemFontOfSize:fontSize weight:NSFontWeightMedium];
      control.toolTip = title;
      control.cell.lineBreakMode = NSLineBreakByTruncatingTail; }
    [controls addSubview:control];
  }
  approvalPanel.contentView = root;
  [approvalPanel makeKeyAndOrderFront:nil];
  if (approvalCompact) {
    approvalHoverTimer = [NSTimer scheduledTimerWithTimeInterval:0.1 repeats:YES block:^(NSTimer* timer) {
      pollApprovalHover();
    }];
    pollApprovalHover();
  }
  return metrics(env, info);
}

static napi_value hideApproval(napi_env env, napi_callback_info info) {
  settleApproval(0);
  return metrics(env, info);
}

static napi_value updateApprovalQueue(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value args[2];
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  int32_t pending = 0;
  if (count >= 1) napi_get_value_int32(env, args[0], &pending);
  NSString* locale = count >= 2 ? stringValue(env, args[1]) : @"en";
  BOOL chinese = [locale hasPrefix:@"zh"];
  if (approvalHeading && approvalBaseTitle) {
    approvalHeading.stringValue = pending > 0 ? approvalCompact
      ? [NSString stringWithFormat:@"%@ · +%d", approvalBaseTitle, pending]
      : [NSString stringWithFormat:chinese ? @"%@ · 后续 %d 条" : @"%@ · %d more", approvalBaseTitle, pending]
      : approvalBaseTitle;
  }
  return metrics(env, info);
}

static napi_value pollEvents(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_create_object(env, &result);
  if (!approvalEvents.empty()) {
    auto event = approvalEvents.front();
    approvalEvents.pop_front();
    setNumber(env, result, "approvalId", event.first);
    setNumber(env, result, "choice", event.second);
  }
  return result;
}

static void exportMethod(napi_env env, napi_value exports, const char* name, napi_callback function) {
  napi_value method;
  napi_create_function(env, name, (size_t)-1, function, nullptr, &method);
  napi_set_named_property(env, exports, name, method);
}

extern "C" __attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  exportMethod(env, exports, "metrics", metrics);
  exportMethod(env, exports, "showIsland", showIsland);
  exportMethod(env, exports, "hideIsland", hideIsland);
  exportMethod(env, exports, "showApproval", showApproval);
  exportMethod(env, exports, "hideApproval", hideApproval);
  exportMethod(env, exports, "updateApprovalQueue", updateApprovalQueue);
  exportMethod(env, exports, "pollEvents", pollEvents);
  exportMethod(env, exports, "setIndicator", setIndicator);
  return exports;
}
