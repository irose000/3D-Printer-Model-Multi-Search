import React, { useState, useRef } from 'react';
import { Search, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';

export default function ModelSearchApp() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [stats, setStats] = useState(null);

  const handleSearch = async () => {
    if (!query.trim()) return;

    setLoading(true);
    setError('');
    
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      
      if (!res.ok) {
        throw new Error('Search failed');
      }
      
      const data = await res.json();
      setResults(data.results);
      setStats({ total: data.total, sources: data.sources });
    } catch (err) {
      setError('Search failed. Make sure the backend server is running on port 3001.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const getSourceColor = (source) => {
    const colors = {
      printables: 'bg-orange-100 text-orange-800',
      thingiverse: 'bg-blue-100 text-blue-800',
      makerworld: 'bg-green-100 text-green-800'
    };
    return colors[source] || 'bg-gray-100 text-gray-800';
  };

  const getSourceName = (source) => {
    const names = {
      printables: 'Printables',
      thingiverse: 'Thingiverse',
      makerworld: 'MakerWorld'
    };
    return names[source] || source;
  };

  // Group results by source
  const groupedResults = results.reduce((acc, result) => {
    if (!acc[result.source]) {
      acc[result.source] = [];
    }
    acc[result.source].push(result);
    return acc;
  }, {});

  return (
    <div className="min-h-screen bg-gray-50">
      <style>
        {`
          @keyframes progress {
            0% { width: 0%; }
            100% { width: 100%; }
          }
          .animate-progress {
            animation: progress 8s ease-in-out;
          }
          .scrollbar-hide::-webkit-scrollbar {
            display: none;
          }
        `}
      </style>
      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="text-center mb-6">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">
            3D Model Search
          </h1>
          <p className="text-gray-600">
            Search across Printables, MakerWorld, and more
          </p>
        </div>

        {/* Search Bar */}
        <div className="mb-6">
          <div className="flex gap-2 max-w-2xl mx-auto">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={20} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Search for 3D models..."
                className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <button
              onClick={handleSearch}
              disabled={loading || !query.trim()}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? (
                <Loader2 className="animate-spin" size={20} />
              ) : (
                'Search'
              )}
            </button>
          </div>
        </div>

        {/* Stats */}
        {stats && (
          <div className="max-w-2xl mx-auto mb-4 p-3 bg-white rounded-lg shadow-sm">
            <div className="flex gap-6 justify-center text-sm">
              <span className="text-gray-600">
                Total Results: <strong>{stats.total}</strong>
              </span>
              <span className="text-orange-600">
                Printables: <strong>{stats.sources.printables}</strong>
              </span>
              <span className="text-blue-600">
                Thingiverse: <strong>{stats.sources.thingiverse}</strong>
              </span>
              <span className="text-green-600">
                MakerWorld: <strong>{stats.sources.makerworld}</strong>
              </span>
            </div>
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className="max-w-2xl mx-auto mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-red-800">{error}</p>
          </div>
        )}

        {/* Loading Progress Bar */}
        {loading && (
          <div className="max-w-2xl mx-auto mb-4">
            <div className="bg-white rounded-lg shadow-sm p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-600">Searching across platforms...</span>
                <span className="text-sm text-gray-500">~8s</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                <div className="bg-blue-600 h-2 rounded-full animate-progress"></div>
              </div>
            </div>
          </div>
        )}

        {/* Results by Source */}
        {results.length > 0 && (
          <div className="space-y-3">
            {Object.entries(groupedResults).map(([source, sourceResults]) => (
              <SourceRow
                key={source}
                source={source}
                sourceName={getSourceName(source)}
                sourceColor={getSourceColor(source)}
                results={sourceResults}
              />
            ))}
          </div>
        )}

        {/* Empty State */}
        {!loading && results.length === 0 && !error && query && (
          <div className="text-center text-gray-500 py-12">
            No results found. Try a different search term.
          </div>
        )}

        {/* Initial State */}
        {!loading && results.length === 0 && !query && (
          <div className="text-center text-gray-500 py-12">
            Enter a search term to find 3D models across multiple platforms.
          </div>
        )}
      </div>
    </div>
  );
}

function SourceRow({ source, sourceName, sourceColor, results }) {
  const scrollContainerRef = useRef(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);

  const updateScrollButtons = () => {
    if (scrollContainerRef.current) {
      const { scrollLeft, scrollWidth, clientWidth } = scrollContainerRef.current;
      setCanScrollLeft(scrollLeft > 0);
      setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 10);
    }
  };

  const scroll = (direction) => {
    if (scrollContainerRef.current) {
      const scrollAmount = 400;
      scrollContainerRef.current.scrollBy({
        left: direction === 'left' ? -scrollAmount : scrollAmount,
        behavior: 'smooth'
      });
      setTimeout(updateScrollButtons, 300);
    }
  };

  React.useEffect(() => {
    updateScrollButtons();
    const container = scrollContainerRef.current;
    if (container) {
      container.addEventListener('scroll', updateScrollButtons);
      return () => container.removeEventListener('scroll', updateScrollButtons);
    }
  }, [results]);

  return (
    <div className="bg-white rounded-lg shadow-sm p-3">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-base font-semibold text-gray-900">
          {sourceName} <span className="text-gray-500 text-sm font-normal">({results.length})</span>
        </h2>
      </div>

      <div className="relative">
        {/* Left scroll button */}
        {canScrollLeft && (
          <button
            onClick={() => scroll('left')}
            className="absolute left-0 top-1/2 -translate-y-1/2 z-10 bg-white shadow-lg rounded-full p-2 hover:bg-gray-100 transition-colors"
          >
            <ChevronLeft size={24} />
          </button>
        )}

        {/* Scrollable container */}
        <div
          ref={scrollContainerRef}
          className="flex gap-3 overflow-x-auto scrollbar-hide pb-1"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {results.map((result) => (
            <a
              key={result.id}
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-shrink-0 w-40 bg-white border border-gray-200 rounded-lg hover:shadow-md transition-shadow"
            >
              <div className="aspect-square bg-gray-200 rounded-t-lg relative overflow-hidden">
                <img
                  src={result.thumbnail}
                  alt={result.title}
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    e.target.src = `https://placehold.co/200x200/e2e8f0/64748b?text=${encodeURIComponent(result.title.substring(0, 15))}`;
                  }}
                />
              </div>
              <div className="p-2">
                <h3 className="font-medium text-xs text-gray-900 mb-1 line-clamp-2 leading-tight">
                  {result.title}
                </h3>
                <p className="text-xs text-gray-500 mb-1 truncate">
                  {result.author}
                </p>
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <span>❤️ {result.likes}</span>
                  <span>⬇️ {result.downloads}</span>
                </div>
              </div>
            </a>
          ))}
        </div>

        {/* Right scroll button */}
        {canScrollRight && (
          <button
            onClick={() => scroll('right')}
            className="absolute right-0 top-1/2 -translate-y-1/2 z-10 bg-white shadow-lg rounded-full p-2 hover:bg-gray-100 transition-colors"
          >
            <ChevronRight size={24} />
          </button>
        )}
      </div>
    </div>
  );
}