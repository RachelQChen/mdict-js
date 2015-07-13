
/*
 * A pure JavaScript implementation of RIPEMD128 using Uint8Array as input/output.
 * By Feng Dihai <fengdh@gmail.com>, 2015/07/09
 *
 * Based on coiscir/jsdigest (https://github.com/coiscir/jsdigest/blob/master/src/hash/ripemd128.js)
 * 
 * ripemd128.js is free software released under terms of the MIT License.
 * You can get a copy on http://opensource.org/licenses/MIT.
 * 
 *
 * RIPEMD-128 (c) 1996 Hans Dobbertin, Antoon Bosselaers, and Bart Preneel
 */

(function (root, factory) {
  "use strict";

  if (typeof define === 'function' && define.amd) {
    // AMD. Register as an anonymous module.
    define(['jquery', 'pako_inflate', 'lzo', 'ripemd128', 'murmurhash3', 'bluebird', 'parseXml'], factory);
  } else {
    // Browser globals
    factory(jQuery, pako, lzo, ripemd128, MurmurHash3, Promise, parseXml);
  }

}(this, function($, pako, lzo, ripemd128, MurmurHash3, Promise, parseXml) {
  
  var UTF_16LE = new TextDecoder('utf-16le');
  
  /**
   * Return the first argument as result, used to simulate side effect such as forward after reading data.
   */
  function conseq() { return arguments[0]; }

  /**
   * Calculate a 32-bit hash code for a string.
   */
  var hash = (function(seed) {
    return function hash(str) { return MurmurHash3.hashString(str.toLowerCase(), 32, seed); }
  })(0xFE176);

  // decrypt encrypted key index (attrs.Encrypted = "2")
  function decrypt(buf, key) {
    key = ripemd128(key);
    var byte, keylen = key.length, prev = 0x36, i = 0, len = buf.length;
    for (; i < len; i++) {
      byte = buf[i];
      byte = ((byte >> 4) | (byte << 4) ); // & 0xFF;  <-- it's already a byte
      byte = byte  ^ prev ^ (i & 0xFF) ^ key[i % keylen];
      prev = buf[i];
      buf[i] = byte;
    }
    return buf;
  }
  
  function sliceThen(file, offset, len) {
    var p = new Promise(function(resolve) {
      var reader = new FileReader;
      reader.onload = function() {
        resolve(reader.result);
      }
      console.log('slice: ', offset, ' + ', len);
      reader.readAsArrayBuffer(file.slice(offset, offset + len));
    });

    p.exec = function(proc /*, args... */) {
      var args = Array.prototype.slice.call(arguments, 1);
      return p.then(function(input) {
        return new Promise(function(resolve) {
          args.unshift(input);
          resolve([proc.apply(null, args), input]);
        });
      });
    };

    return p;
  }
  
  function createKeyTable() {
    var pos = 0, index = 0, 
        arr, view, F64 = new Float64Array(2), U32 = new Uint32Array(F64.buffer);
    var data;
    
    return {
      alloc:  function(len) { 
                arr = new Float64Array(len); view = new Uint32Array(arr.buffer); 
                data = new Uint32Array(len << 1);
              },
      put:    function(hash, offset) {
                data[pos - 1] = offset - data[pos - 2];
                data[pos] = offset;
        
                view[pos++] = hash; 
//                view[pos++] = offset;
                view[pos++] = index++;
              },
      pack:   function() {
                if (pos * 2 < arr.byteLength) {
                  arr = new Float64Array(arr.buffer.slice(0, pos << 3));
                  view = new Uint32Array(arr.buffer);;
                  data = data.subarray(0, view.length);
                }
                return view;
              },
      sort:   function() {
                this.pack();
                Array.prototype.sort.call(arr, function(f1, f2) { return F64[0] = f1, F64[1] = f2, U32[0] - U32[2]; });
              },
      find:   function(hash) {
                var hi = arr.length - 1, lo = 0, i = (lo + hi) >> 1, val = view[i << 1];
                if (hash < 0) { 
                  hash += 0xFFFFFFFF; hash++;
                }
                while (true) {
                  if (hash === val) {
                    var at = view[(i << 1) + 1] << 1;
                    return {offset: data[at], size: at < data.length - 2 ? data[at + 1] : void 0};
                  } else if (hi === lo || i === hi || i === lo) {
                    return;
                  }

                  (hash < val) ? hi = i : lo = i;
                  i = (lo + hi) >> 1;
                  val = view[i << 1];
                }
              },
      debug:  function() { console.log(this.pack()); console.log(data); }
    }
  };
  
  function createRecordTable() {
    var pos = 0, arr;
    return {
      alloc:  function(len) { 
                arr = new Uint32Array(len * 2);
              },
      put:    function(offset_comp, offset_decomp) { 
                arr[pos++] = offset_comp; arr[pos++] = offset_decomp;
              },
      find:   function(keyAt) {
                var hi = (arr.length >> 1) - 1, lo = 0, i = (lo + hi) >> 1, val = arr[(i << 1) + 1];

                if (keyAt > arr[(hi << 1) + 1] || keyAt < 0) {
                  return;
                }

                while (true) {                    
                  if (hi - lo <= 1) {
                    if (i < hi) {
                      return {
                        block_no:     i,
                        comp_offset:  arr[i <<= 1],
                        comp_size:    arr[i + 2] - arr[i],
                        decomp_offset:arr[i + 1],
                        decomp_size:  arr[i + 3] - arr[i + 1]
                      };
                    } else {
                      return;
                    }
                  }

                  (keyAt < val)  ? hi = i : lo = i;
                  i = (lo + hi) >> 1;
                  val = arr[(i << 1) + 1];
                }
              },
      debug:  function() { console.log(arr); },
    };
  }
  
  function parse_mdict(file, ext) {

    // Note: key = keyword or head word
    // Compact key table, which can be viewed as an Uint32Array containing N pairs of (key_hashcode, record_offset) value. 
    // where N is number of key entries.
    // This table should be sorted first according to key_hashcode before searching offset of a key (using Array.prototype.sort).
    // To execute binary search in the sorted key table, you have to calculate its hashcode for any given keyword.
    var KEY_TABLE = createKeyTable();

    // Compact record block table which can be viewed as an Uint32Array containing N+1 pairs of (absolute_offset_comp, offset_decomp) value,
    // where N is number of record blocks. The tail of the table shows offset of the last record block's end.
    // This table should be sorted first according to offset_decomp before searching.
    // How to look up for a given keyword:
    //     1. Find offset (offset_decomp) of record in KEY_TABLE.
    //     2. Execute binary search on RECORD_BLOCK_TABLE to get record block containing the record.
    //     3. Load found record block, using offset to retrieve content of the record.
    var RECORD_BLOCK_TABLE = createRecordTable();


    var START_KEY_BLOCK, START_RECORD_BLOCK;

    var attrs = {},
        _v2,
        _tail,
        _unit,
        _encrypted = [false, false],
        _decoder,
        _searchTextLen,
        _readNum = function(scanner) { return scanner.readInt(); },
        _checksum_v2 = new Function(),
        _readShort = function(scanner) { return scanner.readUint8(); },
        readPartial = sliceThen.bind(null, file);

    function init(attrs) {
      attrs.Encoding = attrs.Encoding || 'UTF-16';
      
      _searchTextLen = (attrs.Encoding === 'UTF-16') ? function(dv, offset) {
        var mark = offset;
        while (dv.getUint16(offset++)) {};
        return [offset - mark, 2];
      } : function(dv, offset) {
        var mark = offset;
        while (dv.getUint8(offset++)) {}
        return [offset - mark, 0];
      };
      
      _decoder = new TextDecoder(attrs.Encoding || 'UTF-16LE');

      _unit = (attrs.Encoding === 'UTF-16') ? 2 : 1;
      if (parseInt(attrs.GeneratedByEngineVersion, 10) >= 2.0) {
        _v2 = true;
        _tail = _unit;

        _readNum = function(scanner) {
          // not going to handle HUGE dictionary file (>4G) inside browser!
          scanner.forward(4);
          return scanner.readInt();
        };
        _readShort = function(scanner) {
          return scanner.readUint16();
        };
        _checksum_v2 = function(scanner) {
          return scanner.checksum();
        };
      } else {
        _tail = 0;
      }
      
      if (attrs.Encrypted & 0x02) {
        _encrypted[1] = decrypt; 
      }
    }

    function Scanner(buf, len) {
      var offset = 0;
      var dv = new DataView(buf);

      var methods = {
        size: function() {
          return len || buf.byteLength;
        },
        forward: function(len) {
          return offset += len;
        },
        offset: function() {
          return offset;
        },

        readInt: function() {
          return conseq(dv.getUint32(offset, false), this.forward(4));
        },
        readUint16: function() {
          return conseq(dv.getUint16(offset, false), this.forward(2));
        },
        readUint8: function() {
          return conseq(dv.getUint8(offset, false), this.forward(1));
        },
        readUTF16: function(len) {
          return conseq(UTF_16LE.decode(new Uint8Array(buf, offset, len)), this.forward(len));
        },
        readText: function(len, tail) {
          if (arguments.length === 0) {
            var r = _searchTextLen(dv, offset);
            len = r[0];
            tail = r[1];
          } else {
            len *= _unit;
          }
          return conseq(_decoder.decode(new Uint8Array(buf, offset, len)), this.forward(len + tail));
        },
        readShort: function() {
          return _readShort(this);
        },
        readNum: function() {
          return _readNum(this);
        },
        checksum: function() {
          return conseq(new Uint8Array(buf, offset, 4), this.forward(4));
        },
        checksum_v2: function() {
          return _checksum_v2(this);
        },

        readBlock: function(len, expectedBufSize, decryptor) {
          var comp_type = dv.getUint8(offset, false);
          if (comp_type === 0) {
            if (_v2) {
              this.forward(8);
            }
            return this;
          } else {
            offset += 8; len -= 8;
            var tmp = new Uint8Array(buf, offset, len);
            if (decryptor) {
              var passkey = new Uint8Array(8);
              passkey.set(new Uint8Array(buf, offset - 4, 4));
              passkey.set([0x95, 0x36, 0x00, 0x00], 4);
              tmp = decryptor(tmp, passkey);
            }
            
            tmp = comp_type === 2 ? pako.inflate(tmp) : lzo.decompress(tmp, expectedBufSize, 4096);
            this.forward(len);
            return Scanner(tmp.buffer, tmp.byteLength);
          }
        },
        // TODO:
        readRaw: function(len) {
          return conseq(new Uint8Array(buf, offset, len), this.forward(len === void 0 ? buf.byteLength - offset :len));
        },
      };

      return Object.create(methods);
    }
    
    function read_file_head(input) {
      return new Scanner(input).readInt();
    }

    function read_header_sect(input, len) {
      var scanner = new Scanner(input),
          header_str = scanner.readUTF16(len).replace(/\0$/, ''); // need to remove endding NUL

      // parse dictionary attributes
      var xml = parseXml(header_str).querySelector('Dictionary, Library_Data').attributes;

      for (var i = 0, item; i < xml.length; i++) {
        item = xml.item(i);
        attrs[item.nodeName] = item.nodeValue;
      }

      attrs.Encrypted = parseInt(attrs.Encrypted, 10) || 0;
      attrs.Compact = attrs.Compact === 'Yes';
      attrs.KeyCaseSensitive = attrs.KeyCaseSensitive === 'Yes';

      mdict_obj.description = attrs.Description;
      
      init(attrs);
      return attrs;
    }

    function read_keyword_sect(input, start, attrs) {
      var scanner = Scanner(input);
      scanner.forward(start);
      return {
        num_blocks:           scanner.readNum(),
        num_entries:          scanner.readNum(),
        key_index_decomp_len: _v2 && scanner.readNum(),
        key_index_comp_len:   scanner.readNum(),
        key_blocks_len:       scanner.readNum(),
        chksum:               scanner.checksum_v2(),
        len:                  scanner.offset() - start,
      };
    }

    function read_keyword(input, keyword_sect) {
      var scanner = Scanner(input).readBlock(keyword_sect.key_index_comp_len, keyword_sect.key_index_decomp_len, _encrypted[1]),
          keyword_index = Array(keyword_sect.num_blocks);
      
      for (var i = 0, pos = START_KEY_BLOCK, kx; i < keyword_sect.num_blocks; i++) {
        kx = read_keyword_index(scanner);
        kx.offset = pos;
        pos += kx.comp_size;
        keyword_index[i] = kx;
      }
      START_RECORD_BLOCK = pos;

      console.log(keyword_index);

      return keyword_index;
    }

    function read_keyword_index(scanner) {
      var size;
      return {
        num_entries: scanner.readNum(),
        first_size:  size = scanner.readShort(),
        first_word:  scanner.readText(size, _tail),
        last_size:   size = scanner.readShort(),
        last_word:   scanner.readText(size, _tail),
        comp_size:   scanner.readNum(),
        decomp_size: scanner.readNum(),
      };
    }

    function read_key_block(scanner, kx) {
      var offset, h, k;
      scanner = scanner.readBlock(kx.comp_size, kx.decomp_size);
      for (var i = 0, size = kx.num_entries; i < size; i++) {
        offset = scanner.readNum();
        h = hash(k = scanner.readText());
        KEY_TABLE.put(h, offset);
        if (ext === 'mdd') {
          console.log(k, offset);
        }
      }
    }

    function read_record_sect(input) {
      var scanner = Scanner(input);
      var record_sect = {
        num_blocks:   scanner.readNum(),
        num_entries:  scanner.readNum(),
        index_len:    scanner.readNum(),
        blocks_len:   scanner.readNum(),
        len:          scanner.offset(),
      };
      return record_sect;
    }

    var p0, p1;
    function read_record_index(input, record_sect) {
      var scanner = Scanner(input),
          size = record_sect.num_blocks,
          record_index = Array(size);

      RECORD_BLOCK_TABLE.alloc(size + 1);
      p0 = START_RECORD_BLOCK; p1 = 0;
      for (var i = 0, rx; i < size; i++) {
        record_index[i] = rx = {
          comp_size:   scanner.readNum(),
          decomp_size: scanner.readNum()
        };
        RECORD_BLOCK_TABLE.put(p0, p1);
        p0 += rx.comp_size;
        p1 += rx.decomp_size;
      }
      RECORD_BLOCK_TABLE.put(p0, p1);
      record_sect.record_index = record_index;
    }
    

    function read_definition(input, keyinfo, block) {
      var scanner = Scanner(input);
      scanner = scanner.readBlock(block.comp_size);
      scanner.forward(keyinfo.offset - block.decomp_offset);
      return scanner.readText();
    }

    function read_object(input, keyinfo, block) {
      var scanner = Scanner(input);
      scanner = scanner.readBlock(block.comp_size);
      scanner.forward(keyinfo.offset - block.decomp_offset);
      return scanner.readRaw(keyinfo.size);
    }

    // TODO: search nearest in case of collision of hashcode
    var LOOKUP = {
      mdx: function(word) {
        word = word.trim().toLowerCase();
        var hashcode = hash(word);
        return new Promise(function(resolve, reject) {
        console.log(hashcode);
          var keyinfo = KEY_TABLE.find(hashcode);
          if (keyinfo) {
            var block = RECORD_BLOCK_TABLE.find(keyinfo.offset);
            readPartial(block.comp_offset, block.comp_size).exec(read_definition, keyinfo, block)
              .spread(function (definition) {
                resolve(definition);
              }).caught(function () {
                reject("*NOT FOUND*");
              });

          } else {
            reject("*NOT FOUND*");
          }
          
        });
      },
      mdd: function(word) {
        word = word.trim().toLowerCase();
        word = '\\' + word.replace(/^[/\\]/, '');
        var hashcode = hash(word);
        console.log(hashcode);
        return new Promise(function(resolve, reject) {
          var keyinfo = KEY_TABLE.find(hashcode);
          if (keyinfo) {
            var block = RECORD_BLOCK_TABLE.find(keyinfo.offset);
            readPartial(block.comp_offset, block.comp_size).exec(read_object, keyinfo, block)
              .spread(function (blob) {
                resolve(blob);
              }).caught(function () {
                reject("*NOT FOUND*");
              });

          } else {
            reject("*NOT FOUND*");
          }
        });
      }
    };
    
    return new Promise(function(resolve) {
      var pos = 0;

      // read first 4 bytes to get header length
      readPartial(pos, 4).exec(read_file_head).spread(function(len) {
        pos += 4;
        // then parse dictionary attributes in remained header section (len + 4),
        // also load next first 44 bytes of keyword section
        return readPartial(pos, len + 48).exec(read_header_sect, len).spread(function(attrs, input) {
          console.log('attrs: ', attrs);
          pos += len + 4;
          return read_keyword_sect(input, len + 4, attrs);
        });
      }).then(function(keyword_sect) {
        console.log('keyword_sect: ', keyword_sect);

        START_KEY_BLOCK = pos + keyword_sect.key_index_comp_len;
        KEY_TABLE.alloc(keyword_sect.num_entries);

        pos += keyword_sect.len;
        
        var len = keyword_sect.key_index_comp_len + keyword_sect.key_blocks_len;
        return readPartial(pos, len).exec(read_keyword, keyword_sect).spread(function (keyword_index, input) {
          var scanner = Scanner(input);
          scanner.forward(keyword_sect.key_index_comp_len);

          for (var i = 0, size = keyword_index.length; i < size; i++) {
//            console.log('== key block # ' + i);
            read_key_block(scanner, keyword_index[i]);
          }

          KEY_TABLE.debug();
          KEY_TABLE.sort();
          KEY_TABLE.debug();

          return len;
        });
      }).then(function(len) {
        pos += len;
        len = 32;
        return readPartial(pos, len).exec(read_record_sect).spread(function (record_sect) {
          pos += record_sect.len;
          START_RECORD_BLOCK = pos + record_sect.index_len;
          return record_sect;
        });
      }).then(function (record_sect) {
        readPartial(pos, record_sect.index_len).exec(read_record_index, record_sect).spread(function () {
            console.log('record_sect: ', record_sect);
            console.log('RECORD BLOCK TABLE: ');
            RECORD_BLOCK_TABLE.debug();
            resolve();
          });
      });      
    }).thenReturn(LOOKUP[ext]);
  };
  
  
  // END OF parse_mdict()
  
  var mdict_obj = {};
  
  return function load(files) {
      return new Promise(function(resolve) {
        var dicts = [];

        Array.prototype.forEach.call(files, function(f) {
          var ext =  /(?:\.([^.]+))?$/.exec(f.name)[1] || 'mdx',
              d = parse_mdict(f, ext);
          dicts.push(d);
          dicts[ext] = d;
        });
        
        mdict_obj.lookup = function lookup(word) {
          return new Promise(function(resolve) {
            (dicts['mdx'] || dicts['mdd']).then(function(lookup) {
                
              lookup(word).done(function(definition) {
              var $content = $('<div>').html(definition);
              if (dicts['mdd']) {
                $content.find('img[src]').each(function() {
                  var $this = $(this);
                  dicts['mdd'].then(function(lookup) {
                    lookup($this.attr('src')).done(function(blob) {
                      blob = new Blob([blob], {type: 'image'});
                      var url = URL.createObjectURL(blob);
                      // TODO: need to call window.URL.revokeObjectURL() to release memory
                      //       or use LRU cache
                      $this.attr('src', url);
                    });
                  });
                });
              }
              resolve($content);
            });
          });
        });
        
      };
     
      Promise.all(dicts).then(function() {
        resolve(mdict_obj);
      });
        
    });
    
  };
}));
