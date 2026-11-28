//go:build windows

package main

import (
	"strings"
	"syscall"
	"unsafe"
)

// Registry reading with the standard library only (no outside packages to vet or update).
const (
	keyRead     = 0x20019
	keyWow64_64 = 0x0100
	regSZ       = 1
	regExpandSZ = 2
	regDWORD    = 4
	regQWORD    = 11
)

type regKey syscall.Handle

func regOpen(root syscall.Handle, path string) (regKey, bool) {
	var h syscall.Handle
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, false
	}
	if syscall.RegOpenKeyEx(root, p, 0, keyRead|keyWow64_64, &h) != nil {
		return 0, false
	}
	return regKey(h), true
}

func (k regKey) Close() { syscall.RegCloseKey(syscall.Handle(k)) }

func (k regKey) Subkeys() []string {
	var n, maxLen uint32
	if syscall.RegQueryInfoKey(syscall.Handle(k), nil, nil, nil, &n, &maxLen, nil, nil, nil, nil, nil, nil) != nil {
		return nil
	}
	out := make([]string, 0, n)
	for i := uint32(0); i < n; i++ {
		buf := make([]uint16, maxLen+2)
		l := uint32(len(buf))
		if syscall.RegEnumKeyEx(syscall.Handle(k), i, &buf[0], &l, nil, nil, nil, nil) == nil {
			out = append(out, syscall.UTF16ToString(buf[:l]))
		}
	}
	return out
}

func (k regKey) raw(name string) (uint32, []byte, bool) {
	p, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return 0, nil, false
	}
	var typ, size uint32
	if syscall.RegQueryValueEx(syscall.Handle(k), p, nil, &typ, nil, &size) != nil || size == 0 || size > 1<<20 {
		return 0, nil, false
	}
	buf := make([]byte, size+2)
	if syscall.RegQueryValueEx(syscall.Handle(k), p, nil, &typ, &buf[0], &size) != nil {
		return 0, nil, false
	}
	return typ, buf[:size], true
}

func (k regKey) String(name string) string {
	typ, b, ok := k.raw(name)
	if !ok || (typ != regSZ && typ != regExpandSZ) || len(b) < 2 {
		return ""
	}
	u := unsafe.Slice((*uint16)(unsafe.Pointer(&b[0])), len(b)/2)
	return strings.TrimSpace(syscall.UTF16ToString(u))
}

func (k regKey) Dword(name string) (uint32, bool) {
	typ, b, ok := k.raw(name)
	if !ok || typ != regDWORD || len(b) < 4 {
		return 0, false
	}
	return uint32(b[0]) | uint32(b[1])<<8 | uint32(b[2])<<16 | uint32(b[3])<<24, true
}

func regExists(root syscall.Handle, path string) bool {
	k, ok := regOpen(root, path)
	if ok {
		k.Close()
	}
	return ok
}
