# Product recommendation: driver updates and iOS/iPadOS

## Recommendation

Add both as separate, opt-in product modules after the Windows application packaging workflow is reliable. Do not put either into the Win32/WinGet package pipeline.

## Driver updates — phase 1 recommendation

Start with visibility and recommendations, not unattended driver installation. Show manufacturer, model, hardware ID where available, driver provider, current version/date, recommended version, source URL, applicability and reboot requirement. Prioritize OEM-supported sources and Windows Update for Business / Intune driver update policies. Require customer approval, pilot rings, maintenance windows and rollback/known-issue notes. Avoid downloading arbitrary driver packages or installing firmware automatically. Driver updates can cause boot, network, storage and device stability problems.

Potential roadmap:
1. Driver inventory and stale/unknown driver reporting.
2. OEM/Windows Update recommendation metadata with source and applicability evidence.
3. Intune driver update policy visibility and deployment monitoring.
4. Controlled approval and pilot workflow.
5. Only later consider package-based driver deployment for explicitly supported OEM/model combinations.

## iOS/iPadOS updates — phase 1 recommendation

Treat this as a separate Apple device-management module. Intune manages iOS/iPadOS update policies and update status through Apple's MDM protocol; it is not a Windows app packaging workflow. Build inventory, OS version compliance, update policy visibility, deferral and deadline reporting first. Device update enforcement depends on device supervision, enrollment type, OS version and Apple's current management behavior. Test on supervised pilot devices before production rollout.

## Scope boundary

Do not promise a single cross-platform update engine. Keep Windows apps, Windows drivers, iOS/iPadOS OS updates and iOS apps as distinct catalog/policy types with their own prerequisites, permissions, deployment status and reporting.
